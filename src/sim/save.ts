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
  type Survey,
  type Town,
  type Train,
  type World,
} from './world';
import type { VehicleType } from './constants';

export const SAVE_FORMAT = 'tsunagumachi';
export const SAVE_VERSION = 4;
/** これより古いセーブは読み込まない（試作版のあいだは変換しない） */
export const OLDEST_SUPPORTED = 4;

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
  surveys: Survey[];
  monthIndex: number;
  monthFin: Record<FinanceCategory, number>;
  history: World['history'];
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
      surveys: w.surveys,
      monthIndex: w.monthIndex,
      monthFin: w.monthFin,
      history: w.history,
    },
  };
}

export function serializeWorld(w: World): string {
  return JSON.stringify(toSaveFile(w));
}

export class SaveError extends Error {}

/** 古い版のセーブを今の形に直す（1.0 になったら、ここに変換を足していく） */
function migrate(file: SaveFile): SaveFile {
  return file;
}

export function deserializeWorld(text: string): World {
  let file: SaveFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new SaveError('セーブデータが壊れています');
  }
  if (!file || file.format !== SAVE_FORMAT) throw new SaveError('ツナグマチのセーブデータではありません');
  if (file.version > SAVE_VERSION) throw new SaveError('新しい版のセーブデータです。ページを再読み込みしてください');
  if (file.version < OLDEST_SUPPORTED) throw new SaveError('試作版の古いセーブデータのため読み込めません。「はじめから」で新しく始めてください');
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
    surveys: s.surveys ?? [],
    monthIndex: s.monthIndex,
    monthFin: { ...emptyFinance(), ...s.monthFin },
    history: s.history,
  };
}
