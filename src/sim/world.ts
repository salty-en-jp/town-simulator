// 世界の状態と基本ヘルパー

import {
  CARGOS,
  ENGINE_SPECS,
  FINANCE,
  INDUSTRY_ECON,
  INDUSTRY_SPECS,
  isEngine,
  STATION,
  WAGON_SPECS,
  type Cargo,
  type EngineType,
  type IndustryType,
  type VehicleType,
} from './constants';
import type { Boom } from './market';
import type { Request, RequestState } from './requests';
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
  /** 留置線：列車から外した車両・買って置いてある車両 */
  stored: Car[];
}

export type { IndustryType };

export interface Industry {
  id: number;
  type: IndustryType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 入力在庫（受け入れる貨物ごと） */
  inputs: Partial<Record<Cargo, number>>;
  /** 出力在庫 */
  outStock: number;
  /** 一次産業：1か月の生産量。加工：1か月に加工できる最大量 */
  prodRate: number;
  producedThisMonth: number;
  transportedThisMonth: number;
  receivedThisMonth: number;
  producedLastMonth: number;
  transportedLastMonth: number;
  receivedLastMonth: number;
  /** はじめからの累計（依頼の進み具合に使う） */
  transportedTotal: number;
  receivedTotal: number;
  /**
   * 持ち主
   * - player：自社（運べる・配当が入る・維持費がかかる）
   * - public：地元の産業（だれでも運べる。権利を買えば自社になる）
   * - other：他社（権利を買うか、輸送契約を結ばないと運べない）
   */
  owner: IndustryOwner;
  /** 輸送契約の期限（ゲーム内の日。0 なら契約なし） */
  contractUntil: number;
  contractFrom: number;
  /** 契約の条件を守れなかった月が続いた数 */
  contractStrikes: number;
  /** 建設中の工場は、完成するまで動かない */
  status: 'active' | 'building';
  readyDay: number;
  dividendThisMonth: number;
  dividendLastMonth: number;
  /** 増産した回数 */
  expansions: number;
  /** 毎月の記録（右詰め：最後が先月）。生産・運び出し・受け入れ */
  hist: { p: number[]; t: number[]; r: number[] };
}

export type IndustryOwner = 'player' | 'public' | 'other';

/** 探鉱（調査中の場所） */
export interface Survey {
  id: number;
  type: IndustryType;
  x: number;
  y: number;
  doneDay: number;
  /** 成功率と、あらかじめ引いておいた乱数（roll < chance なら成功） */
  chance: number;
  roll: number;
  cost: number;
}

/** 届いた量の記録（今月・先月・はじめからの累計） */
export interface Received {
  m: number;
  lm: number;
  total: number;
}

export interface Town {
  id: number;
  /** 元の名前（「桜川」）。駅や産業の名前にも使う */
  name: string;
  /** プレイヤーが名前を変えたら true（そのときは「町」をつけずに表示する） */
  custom?: boolean;
  cx: number;
  cy: number;
  /** 町が貯めている貨物（木材・食料品・建設資材） */
  stock: Partial<Record<Cargo, number>>;
  /** 届いた量（旅客も含む） */
  recv: Partial<Record<Cargo, Received>>;
  growthTimer: number;
  /** 食料品が足りているか（足りていると早く育つ） */
  fed: boolean;
  /** 日次処理で集計 */
  population: number;
  houses: number;
  activeStations: number;
  /** 毎月の人口の記録（右詰め：最後が先月）。v0.5.4 から。古いセーブにはないので、ないときは空から */
  popHist?: number[];
  /** 町の段階（0 村・1 町・2 都市）。上がるだけ。v0.5.6 から（ないときは人口で決める） */
  stage?: 0 | 1 | 2;
  /** 都市になる前のお知らせを出したか */
  cityWarned?: boolean;
}

export type LoadMode = 'if_available' | 'full_any' | 'full_all' | 'none';
export type UnloadMode = 'if_accepted' | 'none';

/** 届け先（駅の集客範囲に受け入れ先が複数あるとき、指令で選べる） */
export interface Dest {
  kind: 'industry' | 'town';
  id: number;
}

export interface Order {
  station: number;
  load: LoadMode;
  unload: UnloadMode;
  /** 届け先。なければいちばん近い受け入れ先 */
  dest?: Dest | null;
  /** 振り分け：受け入れ先ごとの割合（1両の荷を複数の届け先に分けて降ろす） */
  split?: (Dest & { w: number })[] | null;
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

/** 車両1両（機関車・貨車とも）。会社の資産として1両ずつ管理する */
export interface Car {
  id: number;
  type: VehicleType;
  /** 製造日（ゲーム内の日） */
  built: number;
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
  /** 今月の利益（運賃 − 維持費）と、毎月の記録（右詰め：最後が先月） */
  profitThisMonth: number;
  /** 機関車の交換待ち（車庫に入ったら交換して、また走り出す） */
  engineSwap?: { type: EngineType; sellOld: boolean } | null;
  hist: number[];
  trackVersion: number;
}

export type FinanceCategory =
  | 'construction'
  | 'vehicles'
  | 'industry'
  | 'running'
  | 'facilities'
  | 'income'
  | 'dividends'
  | 'rewards'
  | 'interest';
export const FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  'construction',
  'vehicles',
  'industry',
  'running',
  'facilities',
  'income',
  'dividends',
  'rewards',
  'interest',
];

export type GameEvent =
  | { type: 'news'; text: string; tile?: number; tone?: 'good' | 'info' | 'bad' }
  | { type: 'income'; amount: number; tile: number }
  /** 画面の演出（火事など） */
  | { type: 'fx'; kind: 'fire'; tiles: number[] };

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
  /** 依頼の報酬で買えるようになった車両 */
  unlocked: Set<VehicleType>;
  requests: Request[];
  requestState: RequestState;
  surveys: Survey[];
  /** はじめからの月数 */
  monthIndex: number;
  /** 今月の収支（項目ごと） */
  monthFin: Record<FinanceCategory, number>;
  /** 会社の毎月の記録（右詰め） */
  history: { income: number[]; expense: number[]; money: number[]; assets: number[] };
  /** 貨物ごとの相場（v0.5.5 から。ないときは 1） */
  market?: Partial<Record<Cargo, number>>;
  /** 期間限定のブーム（v0.5.5 から） */
  booms?: Boom[];
  /** 会社のランク（RANKS の番号。上がるだけ。v0.5.12 から） */
  rank?: number;
  /** 達成した実績と、その日（v0.5.12 から） */
  achievements?: Record<string, number>;
  /** 実績のための数え（v0.5.12 から） */
  stats?: { cargo?: Partial<Record<Cargo, number>>; boomTons?: number; intercityPax?: number };
}

/** 記録しておく月数 */
export const HIST_MONTHS = 36;

export function pushHist(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > HIST_MONTHS) arr.splice(0, arr.length - HIST_MONTHS);
}

export function emptyFinance(): Record<FinanceCategory, number> {
  return {
    construction: 0,
    vehicles: 0,
    industry: 0,
    running: 0,
    facilities: 0,
    income: 0,
    dividends: 0,
    rewards: 0,
    interest: 0,
  };
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
    unlocked: new Set(),
    requests: [],
    requestState: { nextCheckDay: 20, completed: 0, expired: 0, incomeTotal: 0 },
    surveys: [],
    monthIndex: 0,
    monthFin: emptyFinance(),
    history: { income: [], expense: [], money: [], assets: [] },
    market: {},
    booms: [],
    rank: 0,
    achievements: {},
    stats: {},
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

export function industryAccepts(type: IndustryType): readonly Cargo[] {
  return INDUSTRY_SPECS[type].inputs;
}

export function industryProduces(type: IndustryType): Cargo {
  return INDUSTRY_SPECS[type].output;
}

export function isPrimary(type: IndustryType): boolean {
  return INDUSTRY_SPECS[type].inputs.length === 0;
}

export function recvOf(town: Town, c: Cargo): Received {
  let r = town.recv[c];
  if (!r) town.recv[c] = r = { m: 0, lm: 0, total: 0 };
  return r;
}

export function trainEngine(train: Train): EngineType {
  const t = train.cars[0]?.type;
  return t && isEngine(t) ? t : 'steam';
}

export function trainSpeed(train: Train): number {
  return ENGINE_SPECS[trainEngine(train)].speed;
}

export function trainCapacity(train: Train, cargo: Cargo): number {
  let cap = 0;
  for (const car of train.cars) {
    cap += carCapacity(car, cargo);
  }
  return cap;
}

export function carCapacity(car: Car, cargo: Cargo): number {
  if (isEngine(car.type)) return 0;
  const spec = WAGON_SPECS[car.type];
  return spec.cargo === cargo ? spec.capacity : 0;
}

export function carCargo(car: Car): Cargo | null {
  return isEngine(car.type) ? null : WAGON_SPECS[car.type].cargo;
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
  world.monthFin[cat] -= amount;
}

export function earn(world: World, cat: FinanceCategory, amount: number): void {
  world.money += amount;
  world.finance.thisYear[cat] += amount;
  world.monthFin[cat] += amount;
}

/** ゲーム内の日付（1960年1月1日から） */
export function dateOf(day: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(1960, 0, 1) + day * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 新しい車両を1両つくる（まだどこにも置かない） */
export function newCar(world: World, type: VehicleType): Car {
  return { id: newId(world), type, built: world.day, packets: [] };
}

/** 買える車両か（依頼の報酬で解禁されるものがある） */
/** 車両が登場する年（はじめからあるものは undefined） */
export function vehicleYear(type: VehicleType): number | undefined {
  return (isEngine(type) ? ENGINE_SPECS[type] : WAGON_SPECS[type]).year;
}

/** 買えるか：登場した年を過ぎたか、依頼の報酬で早めに使えるようになったか */
export function canBuy(world: World, type: VehicleType): boolean {
  const y = vehicleYear(type);
  return y === undefined || dateOf(world.day).y >= y || world.unlocked.has(type);
}

/** 機関車にその車両をつなげるか（両数の上限・客車だけ／貨車だけ）。だめなら理由 */
export function consistError(engine: EngineType, wagons: VehicleType[]): string | null {
  const spec = ENGINE_SPECS[engine];
  const short = spec.name.match(/^.*?形/)?.[0] ?? spec.name;
  if (wagons.length > spec.maxCars) return `${short}につなげるのは${spec.maxCars}両までです`;
  for (const t of wagons) {
    if (isEngine(t)) return '機関車は2両つなげません';
    const pax = WAGON_SPECS[t].cargo === 'passengers';
    if (spec.allow === 'pax' && !pax) return `${short}には客車しかつなげません`;
    if (spec.allow === 'freight' && pax) return `${short}には貨車しかつなげません`;
  }
  return null;
}

/** その産業から貨物を運び出せるか（自社・地元・契約中、かつ建設中でない） */
export function canLoadFrom(world: World, ind: Industry): boolean {
  if (ind.status !== 'active') return false;
  return ind.owner !== 'other' || ind.contractUntil > world.day;
}

/** 産業の値段（権利の購入・維持費・増産・契約料の基準） */
export function industryValue(ind: Industry): number {
  if (isPrimary(ind.type)) return Math.round(ind.prodRate * INDUSTRY_ECON.pricePerMonthlyT);
  const base = INDUSTRY_ECON.factoryPrice[ind.type] ?? 30_000_000;
  return Math.round(base * Math.pow(INDUSTRY_ECON.expandFactor, ind.expansions));
}

/** 町の表示名：ふつうは「桜川町」、名前を変えた町は書いたとおり */
export function townLabel(t: { name: string; custom?: boolean }): string {
  return t.custom ? t.name : `${t.name}町`;
}
