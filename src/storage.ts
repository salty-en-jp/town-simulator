// セーブの保存先（ブラウザの中）とファイルの書き出し・読み込み
//
// ・保存先は IndexedDB。使えない環境では localStorage に保存する
// ・枠は「オート」と「1〜3」。オートは毎月と、アプリを裏に回したときに自動で保存
// ・iPhone の Safari は、7日間開かなかったサイトのデータを消すことがある。
//   ホーム画面に追加したアプリは対象外なので、そちらをすすめる。念のため書き出しも用意

import { RANKS } from './sim/company';
import { deserializeWorld, MAX_SAVE_CHARS, SaveError, serializeWorld } from './sim/save';
import { dateOf, Terrain, type World } from './sim/world';

/** challenge はチャレンジモードのオートセーブ（ふつうの街とは別の枠。セーブ画面には並べない） */
export type Slot = 'auto' | 'auto1' | 'auto2' | '1' | '2' | '3' | 'challenge';
/** 画面に並べる順。auto1・auto2 は「ひとつ前・ふたつ前のオートセーブ」（1日1回ずれる） */
export const SLOTS: Slot[] = ['auto', 'auto1', 'auto2', '1', '2', '3'];
export const SLOT_NAMES: Record<Slot, string> = {
  auto: 'オートセーブ',
  auto1: 'ひとつ前のオートセーブ',
  auto2: 'ふたつ前のオートセーブ',
  '1': 'スロット 1',
  '2': 'スロット 2',
  '3': 'スロット 3',
  challenge: 'チャレンジ',
};

export interface SaveMeta {
  slot: Slot;
  savedAt: string;
  day: number;
  money: number;
  population: number;
  trains: number;
  thumb: string;
  /** 会社のランクの名前（v0.5.12 から） */
  rank?: string;
  /** チャレンジの名前（チャレンジ中のとき） */
  challenge?: string;
}

interface SaveRecord {
  slot: Slot;
  meta: SaveMeta;
  data: string;
}

const DB = 'tsunagumachi';
const STORE = 'saves';
const LS_PREFIX = 'tsunagu.save.';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slot' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function putRecord(rec: SaveRecord): Promise<void> {
  const db = await openDb();
  if (db) {
    await tx(db, 'readwrite', (s) => s.put(rec));
    return;
  }
  localStorage.setItem(LS_PREFIX + rec.slot, JSON.stringify(rec));
}

async function getRecord(slot: Slot): Promise<SaveRecord | null> {
  const db = await openDb();
  if (db) return ((await tx(db, 'readonly', (s) => s.get(slot))) as SaveRecord | undefined) ?? null;
  const raw = localStorage.getItem(LS_PREFIX + slot);
  return raw ? (JSON.parse(raw) as SaveRecord) : null;
}

export async function listSaves(): Promise<Partial<Record<Slot, SaveMeta>>> {
  const out: Partial<Record<Slot, SaveMeta>> = {};
  try {
    const db = await openDb();
    if (db) {
      const all = (await tx(db, 'readonly', (s) => s.getAll())) as SaveRecord[];
      for (const r of all) out[r.slot] = r.meta;
    } else {
      for (const slot of SLOTS) {
        const raw = localStorage.getItem(LS_PREFIX + slot);
        if (raw) out[slot] = (JSON.parse(raw) as SaveRecord).meta;
      }
    }
  } catch {
    /* 読めなくても動く */
  }
  return out;
}

export function worldMeta(w: World, slot: Slot): SaveMeta {
  let population = 0;
  for (const t of w.towns.values()) population += t.population;
  return {
    slot,
    savedAt: new Date().toISOString(),
    day: w.day,
    money: w.money,
    population,
    trains: w.trains.size,
    thumb: thumbnail(w),
    rank: RANKS[w.rank ?? 0]?.name,
    challenge: w.challenge?.title,
  };
}

export async function saveTo(slot: Slot, w: World): Promise<void> {
  if (slot === 'auto') await rotateAuto();
  await putRecord({ slot, meta: worldMeta(w, slot), data: serializeWorld(w) });
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * オートセーブの世代を残す：今のオートセーブが「今日より前」に保存されたものなら、
 * ひとつ前 → ふたつ前、今 → ひとつ前 にずらしてから上書きする（1日に1回だけずれる）。
 * 1つが壊れたり、うっかり上書きしても、前の日の街に戻れる
 */
async function rotateAuto(): Promise<void> {
  try {
    const cur = await getRecord('auto');
    if (!cur || dayKey(cur.meta.savedAt) === dayKey(new Date().toISOString())) return;
    const prev = await getRecord('auto1');
    if (prev) await putRecord({ ...prev, slot: 'auto2', meta: { ...prev.meta, slot: 'auto2' } });
    await putRecord({ ...cur, slot: 'auto1', meta: { ...cur.meta, slot: 'auto1' } });
  } catch {
    /* 世代が残せなくても、オートセーブは続ける */
  }
}

// ───────────────────────── バックアップと保存の状態 ─────────────────────────

const LS_BACKUP = 'tsunagu.lastBackup';
const LS_RECORDS = 'tsunagu.challengeRecords';

/** チャレンジの最高記録（ステージごと。今日のステージは日付ごと） */
export interface ChallengeRecord {
  stars: number;
  best: number;
  /** 遊んだ回数 */
  plays: number;
  at: string;
}

export function challengeRecords(): Record<string, ChallengeRecord> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_RECORDS) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 結果を記録する。最高記録を更新したら true */
export function recordChallenge(id: string, stars: number, value: number): boolean {
  const all = challengeRecords();
  const old = all[id];
  const better = !old || stars > old.stars || (stars === old.stars && value > old.best);
  all[id] = better
    ? { stars, best: value, plays: (old?.plays ?? 0) + 1, at: new Date().toISOString() }
    : { ...old, plays: old.plays + 1 };
  try {
    localStorage.setItem(LS_RECORDS, JSON.stringify(all));
  } catch {
    /* 記録できなくても遊べる */
  }
  return better;
}

/** ファイルに書き出した（バックアップした）ことを覚える */
export function markBackup() {
  try {
    localStorage.setItem(LS_BACKUP, new Date().toISOString());
  } catch {
    /* 覚えられなくてもよい */
  }
}

/** 最後にファイルに書き出してからの日数（したことがなければ null） */
export function daysSinceBackup(): number | null {
  try {
    const v = localStorage.getItem(LS_BACKUP);
    if (!v) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000));
  } catch {
    return null;
  }
}

export interface StorageStatus {
  /** ホーム画面に追加したアプリとして開いている */
  standalone: boolean;
  /** iPhone・iPad（Safari の「7日間開かないと消える」決まりがある） */
  ios: boolean;
  /** ブラウザが「消さない」と約束してくれたか（わからなければ null） */
  persisted: boolean | null;
}

export async function storageStatus(): Promise<StorageStatus> {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = !!nav.standalone || (typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches));
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let persisted: boolean | null = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    persisted = null;
  }
  return { standalone, ios, persisted };
}

/** 「データが消えにくいか」：ホーム画面アプリ、または iPhone 以外で消さない約束がある */
export function isSafeStorage(s: StorageStatus): boolean {
  return s.standalone || (!s.ios && s.persisted !== false);
}

export async function loadFrom(slot: Slot): Promise<World | null> {
  const rec = await getRecord(slot);
  return rec ? deserializeWorld(rec.data) : null;
}

export async function deleteSave(slot: Slot): Promise<void> {
  const db = await openDb();
  if (db) await tx(db, 'readwrite', (s) => s.delete(slot));
  else localStorage.removeItem(LS_PREFIX + slot);
}

/** iPhone などで、保存したデータを消されにくくする */
export function requestPersistence() {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* 対応していなくてもよい */
  }
}

// ───────────────────────── サムネイル ─────────────────────────

/** 地図を上から見た小さな画像（セーブ枠の見分け用） */
export function thumbnail(w: World, size = 96): string {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w.w, w.h);
    for (let i = 0; i < w.w * w.h; i++) {
      let col = [140, 191, 104];
      if (w.terrain[i] === Terrain.Water) col = [79, 147, 201];
      else if (w.terrain[i] === Terrain.Trees) col = [72, 128, 64];
      const o = w.occ[i];
      if (w.track[i]) col = [90, 80, 70];
      if (o?.k === 'house') col = o.level >= 2 ? [230, 220, 205] : [200, 85, 61];
      else if (o?.k === 'station') col = [242, 193, 78];
      else if (o?.k === 'industry') col = [150, 100, 60];
      else if (o?.k === 'depot') col = [155, 91, 69];
      img.data.set([...col, 255], i * 4);
    }
    const tmp = document.createElement('canvas');
    tmp.width = w.w;
    tmp.height = w.h;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // 斜め見下ろしの画面に合わせて45度回す
    ctx.translate(size / 2, size / 2);
    ctx.rotate(Math.PI / 4);
    const d = size / Math.SQRT2;
    ctx.drawImage(tmp, -d / 2, -d / 2, d, d);
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}

// ───────────────────────── ファイル ─────────────────────────

async function gzip(text: string): Promise<Blob> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return new Blob([text], { type: 'application/json' });
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip'));
  return new Response(stream).blob();
}

/** 読み込むファイルの大きさの上限（圧縮したまま・広げたあと） */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = MAX_SAVE_CHARS;

/** 上限を超えたら途中でやめて読む（とても大きく広がる圧縮ファイルでも固まらない） */
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SaveError('セーブデータが大きすぎます');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readMaybeGzip(file: Blob): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new SaveError('ファイルが大きすぎます（ツナグマチのセーブではないかもしれません）');
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!DS) throw new Error('この端末では圧縮されたセーブを読めません');
    return readLimited(file.stream().pipeThrough(new DS('gzip')), MAX_TEXT_BYTES);
  }
  return readLimited(file.stream(), MAX_TEXT_BYTES);
}

export function saveFileName(w: World): string {
  const d = dateOf(w.day);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tsunagumachi-${d.y}-${pad(d.m)}-${pad(d.d)}.tsunagu`;
}

/** セーブをファイルにする。iPhone では共有シート（AirDrop・ファイル・LINEなど）を開く */
export async function exportSave(w: World): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await gzip(serializeWorld(w));
  const name = saveFileName(w);
  const file = new File([blob], name, { type: 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try {
      await nav.share({ files: [file], title: 'ツナグマチのセーブ' });
      markBackup();
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  markBackup();
  return 'downloaded';
}

/** ファイルを選んでもらい、セーブを読み込む */
export function pickSaveFile(): Promise<World | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tsunagu,.json,application/octet-stream,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        resolve(deserializeWorld(await readMaybeGzip(f)));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}

export function metaLabel(m: SaveMeta): string {
  const d = dateOf(m.day);
  return `${d.y}年${d.m}月${d.d}日`;
}
