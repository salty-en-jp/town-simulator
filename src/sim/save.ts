// セーブデータの形式（版番号つき）
//
// ・ブラウザに依存しない純粋な変換だけをここに置く（テストできるように）
// ・版番号 SAVE_VERSION を上げたら、migrate() に古い版からの変換を足す
//   → 試作版で作った街が、次の版でも読み込めるようにする

import { Rng } from './rng';
import type { Request, RequestState } from './requests';
import {
  emptyFinance,
  type Depot,
  type FinanceCategory,
  type Industry,
  type Occupant,
  type OrderList,
  type Station,
  type Town,
  type Train,
  type World,
} from './world';
import type { VehicleType } from './constants';

export const SAVE_FORMAT = 'tsunagumachi';
export const SAVE_VERSION = 2;

interface SavedWorld {
  w: number;
  h: number;
  seed: number;
  terrain: string;
  track: string;
  occ: [number, Occupant][];
  stations: Station[];
  depots: Depot[];
  industries: Industry[];
  towns: Town[];
  trains: Train[];
  orderLists: OrderList[];
  nextId: number;
  money: number;
  loan: number;
  maxLoan: number;
  interestRate: number;
  tick: number;
  day: number;
  rng: number;
  finance: { thisYear: Record<FinanceCategory, number>; lastYear: Record<FinanceCategory, number> };
  version: number;
  trackVersion: number;
  firstArrivals: number[];
  unlocked: VehicleType[];
  requests: Request[];
  requestState: RequestState;
}

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  savedAt: string;
  world: SavedWorld;
}

function bytesToB64(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export function toSaveFile(w: World): SaveFile {
  const occ: [number, Occupant][] = [];
  w.occ.forEach((o, i) => {
    if (o) occ.push([i, o]);
  });
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    world: {
      w: w.w,
      h: w.h,
      seed: w.seed,
      terrain: bytesToB64(w.terrain),
      track: bytesToB64(w.track),
      occ,
      stations: [...w.stations.values()],
      depots: [...w.depots.values()],
      industries: [...w.industries.values()],
      towns: [...w.towns.values()],
      trains: [...w.trains.values()],
      orderLists: [...w.orderLists.values()],
      nextId: w.nextId,
      money: w.money,
      loan: w.loan,
      maxLoan: w.maxLoan,
      interestRate: w.interestRate,
      tick: w.tick,
      day: w.day,
      rng: w.rng.state,
      finance: w.finance,
      version: w.version,
      trackVersion: w.trackVersion,
      firstArrivals: [...w.firstArrivals],
      unlocked: [...w.unlocked],
      requests: w.requests,
      requestState: w.requestState,
    },
  };
}

export function serializeWorld(w: World): string {
  return JSON.stringify(toSaveFile(w));
}

export class SaveError extends Error {}

/** 古い版のセーブを今の形に直す（版を上げたらここに足していく） */
function migrate(file: SaveFile): SaveFile {
  if (file.version === 1) migrateV1toV2(file);
  return file;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 版1（v0.2）→ 版2（物流の拡張）
 * ・産業の入力在庫 inStock を、貨物ごとの inputs に
 * ・町の木材・受け取り量を、貨物ごとの stock・recv に
 * ・依頼の種類 haul_logs / deliver_lumber を haul / deliver に
 */
function migrateV1toV2(file: SaveFile) {
  const w = file.world as any;
  for (const ind of w.industries as any[]) {
    if (!ind.inputs) ind.inputs = ind.type === 'sawmill' ? { logs: ind.inStock ?? 0 } : {};
    delete ind.inStock;
  }
  for (const t of w.towns as any[]) {
    if (!t.stock) {
      t.stock = { lumber: t.lumber ?? 0 };
      t.recv = {
        lumber: { m: t.lumberReceivedThisMonth ?? 0, lm: t.lumberReceivedLastMonth ?? 0, total: t.lumberTotal ?? 0 },
        passengers: { m: t.paxReceivedThisMonth ?? 0, lm: t.paxReceivedLastMonth ?? 0, total: t.paxTotal ?? 0 },
      };
      t.fed = false;
    }
    for (const k of ['lumber', 'lumberReceivedThisMonth', 'lumberReceivedLastMonth', 'paxReceivedThisMonth', 'paxReceivedLastMonth', 'lumberTotal', 'paxTotal']) {
      delete t[k];
    }
  }
  for (const r of (w.requests ?? []) as any[]) {
    if (r.kind === 'haul_logs') {
      r.kind = 'haul';
      r.cargo = 'logs';
    } else if (r.kind === 'deliver_lumber') {
      r.kind = 'deliver';
      r.cargo = 'lumber';
    }
  }
  file.version = 2;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function deserializeWorld(text: string): World {
  let file: SaveFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new SaveError('セーブデータが壊れています');
  }
  if (!file || file.format !== SAVE_FORMAT) throw new SaveError('ツナグマチのセーブデータではありません');
  if (file.version > SAVE_VERSION) throw new SaveError('新しい版のセーブデータです。ページを再読み込みしてください');
  file = migrate(file);
  const s = file.world;
  const n = s.w * s.h;
  const occ: (Occupant | null)[] = new Array(n).fill(null);
  for (const [i, o] of s.occ) occ[i] = o;
  const terrain = b64ToBytes(s.terrain);
  const track = b64ToBytes(s.track);
  if (terrain.length !== n || track.length !== n) throw new SaveError('セーブデータが壊れています');
  const rng = new Rng(0);
  rng.state = s.rng >>> 0;
  return {
    w: s.w,
    h: s.h,
    seed: s.seed,
    terrain,
    track,
    occ,
    stations: new Map(s.stations.map((x) => [x.id, x])),
    depots: new Map(s.depots.map((x) => [x.id, { ...x, stored: x.stored ?? [] }])),
    industries: new Map(s.industries.map((x) => [x.id, x])),
    towns: new Map(s.towns.map((x) => [x.id, x])),
    trains: new Map(s.trains.map((x) => [x.id, x])),
    orderLists: new Map(s.orderLists.map((x) => [x.id, x])),
    nextId: s.nextId,
    money: s.money,
    loan: s.loan,
    maxLoan: s.maxLoan,
    interestRate: s.interestRate,
    tick: s.tick,
    day: s.day,
    rng,
    finance: {
      thisYear: { ...emptyFinance(), ...s.finance.thisYear },
      lastYear: { ...emptyFinance(), ...s.finance.lastYear },
    },
    events: [],
    version: s.version,
    trackVersion: s.trackVersion,
    firstArrivals: new Set(s.firstArrivals),
    unlocked: new Set(s.unlocked),
    requests: s.requests ?? [],
    requestState: s.requestState,
  };
}
