// 世界の状態と基本ヘルパー

import { CARGOS, ENGINE, FINANCE, STATION, WAGON_SPECS, type Cargo, type WagonType } from './constants';
import { Rng } from './rng';

export const enum Terrain {
  Grass = 0,
  Water = 1,
  Trees = 2,
}

/** 線路の接続方向（マップの格子座標で） */
export const N = 1; // y-1
export const E = 2; // x+1
export const S = 4; // y+1
export const W = 8; // x-1
export const DIRS = [N, E, S, W] as const;
export const DX: Record<number, number> = { [N]: 0, [E]: 1, [S]: 0, [W]: -1 };
export const DY: Record<number, number> = { [N]: -1, [E]: 0, [S]: 1, [W]: 0 };
export const OPPOSITE: Record<number, number> = { [N]: S, [E]: W, [S]: N, [W]: E };

export type Axis = 'x' | 'y';
export const AXIS_BITS: Record<Axis, number> = { x: E | W, y: N | S };

export type Occupant =
  | { k: 'station'; id: number }
  | { k: 'depot'; id: number }
  | { k: 'industry'; id: number }
  | { k: 'house'; town: number; level: 1 | 2 | 3; variant: number };

export interface Goods {
  waiting: number;
  rating: number;
  /** 列車が一度でも積みに来たか（来るまでは貨物が駅に来ない） */
  visited: boolean;
  daysSincePickup: number;
  /** 最後に来た列車の速さ（マス/日） */
  lastSpeed: number;
}

export interface Station {
  id: number;
  name: string;
  tiles: number[];
  axis: Axis;
  goods: Record<Cargo, Goods>;
  /** 最後に列車が来てからの日数（町の成長判定に使う） */
  daysSinceVisit: number;
}

export interface Depot {
  id: number;
  tile: number;
  dir: number;
}

export type IndustryType = 'forest' | 'sawmill';

export interface Industry {
  id: number;
  type: IndustryType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 入力在庫（製材所の原木） */
  inStock: number;
  /** 出力在庫 */
  outStock: number;
  /** 森林：1か月の生産量。製材所：1か月に加工できる最大量 */
  prodRate: number;
  producedThisMonth: number;
  transportedThisMonth: number;
  receivedThisMonth: number;
  producedLastMonth: number;
  transportedLastMonth: number;
  receivedLastMonth: number;
}

export interface Town {
  id: number;
  name: string;
  cx: number;
  cy: number;
  lumber: number;
  growthTimer: number;
  lumberReceivedThisMonth: number;
  lumberReceivedLastMonth: number;
  paxReceivedThisMonth: number;
  paxReceivedLastMonth: number;
  /** 日次処理で集計 */
  population: number;
  houses: number;
  activeStations: number;
}

export type LoadMode = 'if_available' | 'full_any' | 'full_all' | 'none';
export type UnloadMode = 'if_accepted' | 'none';

export interface Order {
  station: number;
  load: LoadMode;
  unload: UnloadMode;
}

export interface OrderList {
  id: number;
  orders: Order[];
}

export interface Packet {
  amount: number;
  /** 積んだ駅 */
  from: number;
  /** 積んだ駅の看板タイル（距離の計算用。駅が消えても使えるように持っておく） */
  fromTile: number;
  days: number;
}

export interface Car {
  type: 'engine' | WagonType;
  packets: Packet[];
}

export type TrainState =
  | 'in_depot' // 車庫で停止
  | 'running'
  | 'loading'
  | 'stopped' // 線路上で停止
  | 'no_path';

export interface Train {
  id: number;
  name: string;
  cars: Car[];
  orderList: number;
  curOrder: number;
  state: TrainState;
  /** 走行経路（タイル番号）。path[0] が今いるタイル */
  path: number[];
  /** path[0] → path[1] の進み具合 0..1 */
  progress: number;
  /** 通ってきたタイル（新しい順）。車両の描画用 */
  trail: number[];
  /** 今の指令の行き先（-1 は車庫へ） */
  heading: 'order' | 'depot';
  depotId: number;
  loadTimer: number;
  stoppedAt: number; // 停車中の駅（なければ -1）
  incomeThisStop: number;
  profitThisYear: number;
  profitLastYear: number;
  trackVersion: number;
}

export type FinanceCategory = 'construction' | 'vehicles' | 'running' | 'income' | 'interest';
export const FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  'construction',
  'vehicles',
  'running',
  'income',
  'interest',
];

export type GameEvent =
  | { type: 'news'; text: string; tile?: number; tone?: 'good' | 'info' | 'bad' }
  | { type: 'income'; amount: number; tile: number };

export interface World {
  w: number;
  h: number;
  seed: number;
  terrain: Uint8Array;
  track: Uint8Array;
  occ: (Occupant | null)[];
  stations: Map<number, Station>;
  depots: Map<number, Depot>;
  industries: Map<number, Industry>;
  towns: Map<number, Town>;
  trains: Map<number, Train>;
  orderLists: Map<number, OrderList>;
  nextId: number;
  money: number;
  loan: number;
  maxLoan: number;
  interestRate: number;
  tick: number;
  day: number;
  rng: Rng;
  finance: { thisYear: Record<FinanceCategory, number>; lastYear: Record<FinanceCategory, number> };
  events: GameEvent[];
  /** 建物・地形が変わるたびに増える（描画の更新用） */
  version: number;
  /** 線路が変わるたびに増える（経路の再計算用） */
  trackVersion: number;
  firstArrivals: Set<number>;
}

export function emptyFinance(): Record<FinanceCategory, number> {
  return { construction: 0, vehicles: 0, running: 0, income: 0, interest: 0 };
}

export function createEmptyWorld(w: number, h: number, seed: number): World {
  return {
    w,
    h,
    seed,
    terrain: new Uint8Array(w * h),
    track: new Uint8Array(w * h),
    occ: new Array(w * h).fill(null),
    stations: new Map(),
    depots: new Map(),
    industries: new Map(),
    towns: new Map(),
    trains: new Map(),
    orderLists: new Map(),
    nextId: 1,
    money: FINANCE.startMoney,
    loan: FINANCE.startLoan,
    maxLoan: FINANCE.maxLoan,
    interestRate: FINANCE.interestRate,
    tick: 0,
    day: 0,
    rng: new Rng(seed),
    finance: { thisYear: emptyFinance(), lastYear: emptyFinance() },
    events: [],
    version: 0,
    trackVersion: 0,
    firstArrivals: new Set(),
  };
}

export function newId(world: World): number {
  return world.nextId++;
}

export function idx(world: World, x: number, y: number): number {
  return y * world.w + x;
}

export function tx(world: World, i: number): number {
  return i % world.w;
}

export function ty(world: World, i: number): number {
  return Math.floor(i / world.w);
}

export function inBounds(world: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.w && y < world.h;
}

export function neighbor(world: World, i: number, dir: number): number {
  const x = tx(world, i) + DX[dir];
  const y = ty(world, i) + DY[dir];
  return inBounds(world, x, y) ? idx(world, x, y) : -1;
}

/** 隣り合うタイルの方向（隣でなければ 0） */
export function dirBetween(world: World, a: number, b: number): number {
  const dx = tx(world, b) - tx(world, a);
  const dy = ty(world, b) - ty(world, a);
  if (dx === 1 && dy === 0) return E;
  if (dx === -1 && dy === 0) return W;
  if (dx === 0 && dy === 1) return S;
  if (dx === 0 && dy === -1) return N;
  return 0;
}

export function manhattan(world: World, a: number, b: number): number {
  return Math.abs(tx(world, a) - tx(world, b)) + Math.abs(ty(world, a) - ty(world, b));
}

/** a から dir 方向へ線路がつながっているか（両側に接続があること） */
export function connected(world: World, a: number, dir: number): number {
  if ((world.track[a] & dir) === 0) return -1;
  const b = neighbor(world, a, dir);
  if (b < 0) return -1;
  if ((world.track[b] & OPPOSITE[dir]) === 0) return -1;
  return b;
}

export function newGoods(): Record<Cargo, Goods> {
  const g = {} as Record<Cargo, Goods>;
  for (const c of CARGOS) {
    g[c] = {
      waiting: 0,
      rating: STATION.initialRating,
      visited: false,
      daysSincePickup: 0,
      lastSpeed: 0,
    };
  }
  return g;
}

/** 駅の看板の位置（駅タイルの真ん中） */
export function stationSign(st: Station): number {
  return st.tiles[Math.floor(st.tiles.length / 2)];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 駅の集客範囲（チェビシェフ距離で catchment マス以内） */
export function stationCatchment(world: World, st: Station): Rect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const t of st.tiles) {
    const x = tx(world, t),
      y = ty(world, t);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const r = STATION.catchment;
  return {
    x0: Math.max(0, x0 - r),
    y0: Math.max(0, y0 - r),
    x1: Math.min(world.w - 1, x1 + r),
    y1: Math.min(world.h - 1, y1 + r),
  };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

export function rectOverlapsIndustry(r: Rect, ind: Industry): boolean {
  return !(ind.x + ind.w - 1 < r.x0 || ind.x > r.x1 || ind.y + ind.h - 1 < r.y0 || ind.y > r.y1);
}

export function industryAccepts(type: IndustryType): Cargo | null {
  return type === 'sawmill' ? 'logs' : null;
}

export function industryProduces(type: IndustryType): Cargo {
  return type === 'forest' ? 'logs' : 'lumber';
}

export function trainSpeed(_train: Train): number {
  return ENGINE.speed;
}

export function trainCapacity(train: Train, cargo: Cargo): number {
  let cap = 0;
  for (const car of train.cars) {
    if (car.type === 'engine') continue;
    cap += carCapacity(car, cargo);
  }
  return cap;
}

export function carCapacity(car: Car, cargo: Cargo): number {
  if (car.type === 'engine') return 0;
  const spec = WAGON_SPECS[car.type];
  return spec.cargo === cargo ? spec.capacity : 0;
}

export function carCargo(car: Car): Cargo | null {
  return car.type === 'engine' ? null : WAGON_SPECS[car.type].cargo;
}

export function carLoad(car: Car): number {
  let s = 0;
  for (const p of car.packets) s += p.amount;
  return s;
}

export function pushEvent(world: World, ev: GameEvent): void {
  world.events.push(ev);
  if (world.events.length > 200) world.events.splice(0, world.events.length - 200);
}

export function spend(world: World, cat: FinanceCategory, amount: number): void {
  world.money -= amount;
  world.finance.thisYear[cat] -= amount;
}

export function earn(world: World, cat: FinanceCategory, amount: number): void {
  world.money += amount;
  world.finance.thisYear[cat] += amount;
}

/** ゲーム内の日付（1960年1月1日から） */
export function dateOf(day: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(1960, 0, 1) + day * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
