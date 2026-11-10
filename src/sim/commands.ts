// プレイヤーの操作（コマンド）。
// すべて「見積もりだけ（dry）」でも呼べる。見積もりなら世界を変えずに費用とエラーだけ返す。

import { ruleBlocksBorrow, ruleBlocksVehicle } from './challenge';
import {
  COSTS,
  FINANCE,
  isEngine,
  STATION,
  vehicleCost,
  vehicleName,
  vehicleValue,
  type EngineType,
  type VehicleType,
  type WagonType,
} from './constants';
import { dragLine, polyLine, rectTiles, straightLine } from './track';
import {
  AXIS_BITS,
  DIRS,
  dirBetween,
  E,
  N,
  neighbor,
  newGoods,
  newId,
  OPPOSITE,
  S,
  spend,
  earn,
  Terrain,
  tx,
  ty,
  W,
  canBuy,
  consistError,
  vehicleYear,
  newCar,
  type Axis,
  type Car,
  type Depot,
  type Dest,
  type LoadMode,
  type Occupant,
  type Order,
  type Station,
  type Train,
  type UnloadMode,
  type World,
} from './world';

export interface CmdResult {
  ok: boolean;
  cost: number;
  error?: string;
  undo?: UndoRecord;
  /** 作られたもの（駅・車庫・列車）の ID */
  id?: number;
}

interface TileSnap {
  i: number;
  terrain: number;
  track: number;
  occ: Occupant | null;
}

export interface UndoRecord {
  label: string;
  cost: number;
  before: TileSnap[];
  after: TileSnap[];
  stationsBefore: Map<number, Station | null>;
  depotsBefore: Map<number, Depot | null>;
}

const fail = (error: string, cost = 0): CmdResult => ({ ok: false, cost, error });

export function formatYen(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(Math.round(v));
  if (a >= 100_000_000) {
    const oku = Math.floor(a / 100_000_000);
    const man = Math.floor((a % 100_000_000) / 10_000);
    return `${sign}¥${oku}億${man > 0 ? man.toLocaleString('ja-JP') + '万' : ''}`;
  }
  if (a >= 10_000) return `${sign}¥${Math.floor(a / 10_000).toLocaleString('ja-JP')}万`;
  return `${sign}¥${a.toLocaleString('ja-JP')}`;
}

function snapTiles(world: World, tiles: Iterable<number>): TileSnap[] {
  const out: TileSnap[] = [];
  for (const i of new Set(tiles)) {
    const o = world.occ[i];
    out.push({ i, terrain: world.terrain[i], track: world.track[i], occ: o ? { ...o } : null });
  }
  return out;
}

function sameOcc(a: Occupant | null, b: Occupant | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneStation(st: Station): Station {
  return { ...st, tiles: [...st.tiles] };
}

class Recorder {
  stationsBefore = new Map<number, Station | null>();
  depotsBefore = new Map<number, Depot | null>();
  before: TileSnap[];
  constructor(
    private world: World,
    private tiles: number[],
  ) {
    this.before = snapTiles(world, tiles);
  }
  station(id: number) {
    if (this.stationsBefore.has(id)) return;
    const st = this.world.stations.get(id);
    this.stationsBefore.set(id, st ? cloneStation(st) : null);
  }
  depot(id: number) {
    if (this.depotsBefore.has(id)) return;
    const d = this.world.depots.get(id);
    this.depotsBefore.set(id, d ? { ...d, stored: [...d.stored] } : null);
  }
  finish(label: string, cost: number): UndoRecord {
    return {
      label,
      cost,
      before: this.before,
      after: snapTiles(this.world, this.tiles),
      stationsBefore: this.stationsBefore,
      depotsBefore: this.depotsBefore,
    };
  }
}

/** 列車がいるタイル（線路を外すと困るタイル） */
function trainTiles(world: World): Set<number> {
  const s = new Set<number>();
  for (const t of world.trains.values()) {
    if (t.state === 'in_depot') continue;
    if (t.path.length > 0) s.add(t.path[0]);
    if (t.path.length > 1 && t.progress > 0) s.add(t.path[1]);
  }
  return s;
}

function stationUsedInOrders(world: World, stationId: number): boolean {
  for (const ol of world.orderLists.values()) {
    if (ol.orders.some((o) => o.station === stationId)) return true;
  }
  return false;
}

function trainsInDepot(world: World, depotId: number): boolean {
  for (const t of world.trains.values()) {
    if (t.depotId === depotId && t.state === 'in_depot') return true;
  }
  return false;
}

function changed(world: World, trackChanged: boolean) {
  world.version++;
  if (trackChanged) world.trackVersion++;
}

// ───────────────────────── 線路 ─────────────────────────

export function buildTrack(
  world: World,
  a: number,
  b: number,
  opts: { remove?: boolean; dry?: boolean } = {},
): CmdResult {
  const path = trackPath(world, a, b, !!opts.remove);
  if (path.length < 2) return fail('ドラッグして線路を引いてください');
  return opts.remove ? removeTrackPath(world, path, !!opts.dry) : buildTrackPath(world, path, !!opts.dry);
}

/**
 * ドラッグの形の決め方。ふつうは長い方の軸を先に進む L 字。
 * それだと駅や車庫の向きと合わない場合は、逆の L 字、
 * さらに Z 字（横→縦→横、縦→横→縦）を試して、建てられる形を選ぶ。
 */
export function trackPath(world: World, a: number, b: number, remove = false): number[] {
  const first = dragLine(world, a, b);
  if (remove || first.length < 2) return first;
  if (buildTrackPath(world, first, true).ok) return first;
  const ax = tx(world, a),
    ay = ty(world, a),
    bx = tx(world, b),
    by = ty(world, b);
  const xFirst = Math.abs(bx - ax) >= Math.abs(by - ay);
  const mx = Math.round((ax + bx) / 2),
    my = Math.round((ay + by) / 2);
  const candidates = [
    dragLine(world, a, b, !xFirst),
    polyLine(world, [
      [ax, ay],
      [mx, ay],
      [mx, by],
      [bx, by],
    ]),
    polyLine(world, [
      [ax, ay],
      [ax, my],
      [bx, my],
      [bx, by],
    ]),
  ];
  for (const c of candidates) if (c.length >= 2 && buildTrackPath(world, c, true).ok) return c;
  return first;
}

function connectError(world: World, t: number, dir: number): string | null {
  const o = world.occ[t];
  if (!o) return null;
  if (o.k === 'house') return '建物があります';
  if (o.k === 'industry') return '産業があります';
  if (o.k === 'station') {
    const st = world.stations.get(o.id)!;
    return AXIS_BITS[st.axis] & dir ? null : '駅の向きと合いません';
  }
  if (o.k === 'depot') {
    const d = world.depots.get(o.id)!;
    return d.dir === dir ? null : '車庫の入口の向きと合いません';
  }
  return null;
}

function buildTrackPath(world: World, path: number[], dry: boolean): CmdResult {
  let cost = 0;
  const trees = new Set<number>();
  const adds: [number, number][] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const p = path[k],
      q = path[k + 1];
    const d = dirBetween(world, p, q);
    const e1 = connectError(world, p, d) ?? connectError(world, q, OPPOSITE[d]);
    if (e1) return fail(e1);
    const has = (world.track[p] & d) !== 0 && (world.track[q] & OPPOSITE[d]) !== 0;
    if (has) continue;
    const water = world.terrain[p] === Terrain.Water || world.terrain[q] === Terrain.Water;
    const rock = world.terrain[p] === Terrain.Rock || world.terrain[q] === Terrain.Rock;
    cost += COSTS.trackPerConnection * (water ? COSTS.trackWaterMultiplier : rock ? COSTS.trackRockMultiplier : 1);
    adds.push([p, d]);
    for (const t of [p, q]) if (world.terrain[t] === Terrain.Trees) trees.add(t);
  }
  cost += trees.size * COSTS.clearTrees;
  if (adds.length === 0) return fail('もう線路があります');
  if (dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);

  const rec = new Recorder(world, path);
  for (const [p, d] of adds) {
    world.track[p] |= d;
    world.track[neighbor(world, p, d)] |= OPPOSITE[d];
  }
  for (const t of trees) world.terrain[t] = Terrain.Grass;
  spend(world, 'construction', cost);
  changed(world, true);
  return { ok: true, cost, undo: rec.finish('線路の建設', cost) };
}

function removeTrackPath(world: World, path: number[], dry: boolean): CmdResult {
  let cost = 0;
  const busy = trainTiles(world);
  const removes: [number, number][] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const p = path[k],
      q = path[k + 1];
    const d = dirBetween(world, p, q);
    const op = world.occ[p],
      oq = world.occ[q];
    if (op?.k === 'station' || oq?.k === 'station' || op?.k === 'depot' || oq?.k === 'depot') continue;
    if ((world.track[p] & d) === 0 && (world.track[q] & OPPOSITE[d]) === 0) continue;
    if (busy.has(p) || busy.has(q)) return fail('列車がいます');
    removes.push([p, d]);
    cost += COSTS.removeTrackPerConnection;
  }
  if (removes.length === 0) return fail('撤去する線路がありません');
  if (dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);
  const rec = new Recorder(world, path);
  for (const [p, d] of removes) {
    world.track[p] &= ~d;
    world.track[neighbor(world, p, d)] &= ~OPPOSITE[d];
  }
  spend(world, 'construction', cost);
  changed(world, true);
  return { ok: true, cost, undo: rec.finish('線路の撤去', cost) };
}

// ───────────────────────── 駅 ─────────────────────────

export function guessAxis(world: World, t: number): Axis {
  const bits = world.track[t];
  if (bits && (bits & ~AXIS_BITS.y) === 0) return 'y';
  if (bits && (bits & ~AXIS_BITS.x) === 0) return 'x';
  const ew = [E, W].some((d) => {
    const nb = neighbor(world, t, d);
    return nb >= 0 && (world.track[nb] & OPPOSITE[d]) !== 0;
  });
  if (ew) return 'x';
  const ns = [N, S].some((d) => {
    const nb = neighbor(world, t, d);
    return nb >= 0 && (world.track[nb] & OPPOSITE[d]) !== 0;
  });
  return ns ? 'y' : 'x';
}

function nearestTown(world: World, t: number) {
  let best = null as null | { id: number; name: string; cx: number; cy: number };
  let bd = Infinity;
  for (const town of world.towns.values()) {
    const d = Math.abs(town.cx - tx(world, t)) + Math.abs(town.cy - ty(world, t));
    if (d < bd) {
      bd = d;
      best = town;
    }
  }
  return best;
}

export function makeName(world: World, t: number, suffix: string, taken: Set<string>): string {
  const town = nearestTown(world, t);
  const base = town ? town.name : 'ツナグ';
  const cand = [`${base}${suffix}`];
  if (town) {
    const dx = tx(world, t) - town.cx,
      dy = ty(world, t) - town.cy;
    // 画面上の向き（斜め見下ろし）で東西南北をつける
    const sx = dx - dy,
      sy = dx + dy;
    const dirName = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? '東' : '西') : sy > 0 ? '南' : '北';
    cand.push(`${base}${dirName}${suffix}`, `${dirName}${base}${suffix}`);
  }
  for (const c of cand) if (!taken.has(c)) return c;
  for (let n = 2; ; n++) {
    const c = `${base}第${n}${suffix}`;
    if (!taken.has(c)) return c;
  }
}

/** 1マスの駅の向き：指定がなければ、まわりの線路から推測する */
export function stationAxisFor(world: World, tiles: number[], axis?: Axis): Axis {
  if (tiles.length > 1) return ty(world, tiles[0]) === ty(world, tiles[1]) ? 'x' : 'y';
  return axis ?? guessAxis(world, tiles[0]);
}

export function buildStation(
  world: World,
  a: number,
  b: number,
  opts: { dry?: boolean; axis?: Axis } = {},
): CmdResult {
  const tiles = straightLine(world, a, b, STATION.maxLength);
  const axis = stationAxisFor(world, tiles, opts.axis);
  let cost = 0;
  for (const t of tiles) {
    if (world.terrain[t] === Terrain.Water) return fail('水の上には建てられません');
    const o = world.occ[t];
    if (o) return fail(o.k === 'house' ? '建物があります' : o.k === 'industry' ? '産業があります' : 'すでに建物があります');
    if (world.track[t] & ~AXIS_BITS[axis]) return fail('線路の向きと合いません');
    cost += COSTS.stationPerTile;
    if (world.terrain[t] === Terrain.Trees) cost += COSTS.clearTrees;
  }
  // 隣の駅と結合
  const adj = new Set<number>();
  for (const t of tiles) {
    for (const d of DIRS) {
      const nb = neighbor(world, t, d);
      const o = nb >= 0 ? world.occ[nb] : null;
      if (o?.k === 'station' && world.stations.get(o.id)!.axis === axis) adj.add(o.id);
    }
  }
  if (adj.size > 1) return fail('2つ以上の駅に隣り合っています');
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);

  const rec = new Recorder(world, tiles);
  let st: Station;
  if (adj.size === 1) {
    st = world.stations.get([...adj][0])!;
    rec.station(st.id);
    st.tiles.push(...tiles);
  } else {
    const id = newId(world);
    rec.station(id);
    const taken = new Set([...world.stations.values()].map((s) => s.name));
    st = {
      id,
      name: makeName(world, tiles[Math.floor(tiles.length / 2)], '駅', taken),
      tiles: [...tiles],
      axis,
      goods: newGoods(),
      daysSinceVisit: 999,
    };
    world.stations.set(id, st);
  }
  for (const t of tiles) {
    world.occ[t] = { k: 'station', id: st.id };
    world.track[t] = AXIS_BITS[axis];
    world.terrain[t] = Terrain.Grass;
  }
  spend(world, 'construction', cost);
  changed(world, true);
  return { ok: true, cost, id: st.id, undo: rec.finish('駅の建設', cost) };
}

// ───────────────────────── 車庫 ─────────────────────────

export function buildDepot(world: World, t: number, opts: { dry?: boolean } = {}): CmdResult {
  if (world.terrain[t] === Terrain.Water) return fail('水の上には建てられません');
  if (world.occ[t]) return fail('すでに建物があります');
  if (world.track[t]) return fail('線路の上には建てられません（線路の隣に置いてください）');
  let dir = 0;
  for (const d of DIRS) {
    const nb = neighbor(world, t, d);
    if (nb < 0 || world.track[nb] === 0) continue;
    const o = world.occ[nb];
    if (o?.k === 'depot') continue;
    if (o?.k === 'station' && !(AXIS_BITS[world.stations.get(o.id)!.axis] & OPPOSITE[d])) continue;
    dir = d;
    if (!o) break; // 普通の線路を優先
  }
  if (!dir) return fail('線路の隣に置いてください');
  let cost = COSTS.depot;
  if (world.terrain[t] === Terrain.Trees) cost += COSTS.clearTrees;
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);
  const nb = neighbor(world, t, dir);
  const rec = new Recorder(world, [t, nb]);
  const id = newId(world);
  rec.depot(id);
  world.depots.set(id, { id, tile: t, dir, stored: [] });
  world.occ[t] = { k: 'depot', id };
  world.track[t] = dir;
  world.track[nb] |= OPPOSITE[dir];
  world.terrain[t] = Terrain.Grass;
  spend(world, 'construction', cost);
  changed(world, true);
  return { ok: true, cost, id, undo: rec.finish('車庫の建設', cost) };
}

// ───────────────────────── 解体 ─────────────────────────

export function demolish(world: World, a: number, b: number, opts: { dry?: boolean } = {}): CmdResult {
  const tiles = rectTiles(world, a, b);
  const busy = trainTiles(world);
  let cost = 0;
  let lastError: string | null = null;
  const actions: (() => void)[] = [];
  const stationRemovals = new Map<number, number>();
  for (const t of tiles) {
    const o = world.occ[t];
    if (o?.k === 'industry') {
      lastError = '産業は撤去できません';
      continue;
    }
    if (o?.k === 'house') {
      cost += COSTS.demolishHouse;
      actions.push(() => (world.occ[t] = null));
      continue;
    }
    if (world.track[t] && busy.has(t)) {
      lastError = '列車がいます';
      continue;
    }
    if (o?.k === 'station') {
      stationRemovals.set(o.id, (stationRemovals.get(o.id) ?? 0) + 1);
      cost += COSTS.demolishStationTile;
      actions.push(() => {
        const st = world.stations.get(o.id)!;
        st.tiles = st.tiles.filter((x) => x !== t);
        world.occ[t] = null;
        world.track[t] = 0;
        if (st.tiles.length === 0) world.stations.delete(st.id);
      });
      continue;
    }
    if (o?.k === 'depot') {
      if (trainsInDepot(world, o.id)) {
        lastError = '車庫に列車があります';
        continue;
      }
      if (world.depots.get(o.id)!.stored.length > 0) {
        lastError = '車庫の留置線に車両があります（売るか、列車につないで移してください）';
        continue;
      }
      cost += COSTS.demolishDepot;
      actions.push(() => {
        world.depots.delete(o.id);
        world.occ[t] = null;
        world.track[t] = 0;
      });
      continue;
    }
    if (world.track[t]) {
      cost += COSTS.demolishTile;
      actions.push(() => (world.track[t] = 0));
      continue;
    }
    if (world.terrain[t] === Terrain.Trees) {
      cost += COSTS.clearTrees;
      actions.push(() => (world.terrain[t] = Terrain.Grass));
    }
  }
  // 駅を丸ごと消す場合、指令で使われていたら止める
  for (const [id, n] of stationRemovals) {
    const st = world.stations.get(id)!;
    if (n >= st.tiles.length && stationUsedInOrders(world, id)) {
      return fail(`${st.name}は指令で使われています（先に指令を消してください）`);
    }
  }
  if (actions.length === 0) return fail(lastError ?? '解体するものがありません');
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);
  const rec = new Recorder(world, tiles);
  for (const id of stationRemovals.keys()) rec.station(id);
  for (const t of tiles) {
    const o = world.occ[t];
    if (o?.k === 'depot') rec.depot(o.id);
  }
  for (const act of actions) act();
  spend(world, 'construction', cost);
  changed(world, true);
  return { ok: true, cost, undo: rec.finish('解体', cost) };
}

// ───────────────────────── 元に戻す ─────────────────────────

export function canUndo(world: World, rec: UndoRecord): string | null {
  for (const s of rec.after) {
    if (world.terrain[s.i] !== s.terrain || world.track[s.i] !== s.track || !sameOcc(world.occ[s.i], s.occ)) {
      return 'その後に変更があったため元に戻せません';
    }
  }
  const busy = trainTiles(world);
  for (const s of rec.after) {
    const b = rec.before.find((x) => x.i === s.i)!;
    if (busy.has(s.i) && b.track !== s.track) return '列車がいるため元に戻せません';
  }
  for (const [id, before] of rec.stationsBefore) {
    if (before === null && stationUsedInOrders(world, id)) return '指令で使われている駅は元に戻せません';
  }
  for (const [id, before] of rec.depotsBefore) {
    if (before === null && [...world.trains.values()].some((t) => t.depotId === id)) {
      return '列車を買った車庫は元に戻せません';
    }
  }
  return null;
}

export function applyUndo(world: World, rec: UndoRecord): CmdResult {
  const err = canUndo(world, rec);
  if (err) return fail(err);
  for (const s of rec.before) {
    world.terrain[s.i] = s.terrain;
    world.track[s.i] = s.track;
    world.occ[s.i] = s.occ ? { ...s.occ } : null;
  }
  for (const [id, before] of rec.stationsBefore) {
    const cur = world.stations.get(id);
    if (before === null) world.stations.delete(id);
    else world.stations.set(id, { ...cloneStation(before), goods: cur?.goods ?? before.goods });
  }
  for (const [id, before] of rec.depotsBefore) {
    if (before === null) world.depots.delete(id);
    else world.depots.set(id, { ...before, stored: world.depots.get(id)?.stored ?? before.stored });
  }
  earn(world, 'construction', rec.cost);
  changed(world, true);
  return { ok: true, cost: -rec.cost };
}

// ───────────────────────── お金 ─────────────────────────

export function borrow(world: World): CmdResult {
  const rule = ruleBlocksBorrow(world);
  if (rule) return fail(rule);
  if (world.loan + FINANCE.loanStep > world.maxLoan) return fail('これ以上は借りられません');
  world.loan += FINANCE.loanStep;
  world.money += FINANCE.loanStep;
  return { ok: true, cost: 0 };
}

export function repay(world: World): CmdResult {
  if (world.loan <= 0) return fail('借入金はありません');
  const amt = Math.min(FINANCE.loanStep, world.loan);
  if (world.money < amt) return fail('資金が足りません');
  world.loan -= amt;
  world.money -= amt;
  return { ok: true, cost: 0 };
}

// ───────────────────────── 列車・車両 ─────────────────────────
//
// 車両は1両ずつの資産。車庫には「留置線」があり、列車から外した車両や
// 買っただけの車両を置いておける（維持費はかからず、車庫代だけ）。

export function trainCost(types: VehicleType[]): number {
  return types.reduce((s, t) => s + vehicleCost(t), 0);
}

function nextTrainName(world: World): string {
  let n = 1;
  const names = new Set([...world.trains.values()].map((t) => t.name));
  while (names.has(`列車 ${n}`)) n++;
  return `列車 ${n}`;
}

function createTrain(world: World, depot: Depot, cars: Car[], orderList?: number, orders?: Order[]): Train {
  let ol = orderList;
  if (ol === undefined) {
    ol = newId(world);
    world.orderLists.set(ol, { id: ol, orders: (orders ?? []).map((o) => ({ ...o })) });
  }
  const id = newId(world);
  const train: Train = {
    id,
    name: nextTrainName(world),
    cars,
    orderList: ol,
    curOrder: 0,
    state: 'in_depot',
    path: [depot.tile],
    progress: 0,
    trail: [],
    heading: 'order',
    depotId: depot.id,
    loadTimer: 0,
    stoppedAt: -1,
    incomeThisStop: 0,
    profitThisYear: 0,
    profitLastYear: 0,
    profitThisMonth: 0,
    hist: [],
    trackVersion: -1,
  };
  world.trains.set(id, train);
  return train;
}

function removeTrain(world: World, t: Train) {
  world.trains.delete(t.id);
  const stillUsed = [...world.trains.values()].some((x) => x.orderList === t.orderList);
  if (!stillUsed) world.orderLists.delete(t.orderList);
}

/** 機関車と貨車をまとめて買って、列車にする（クローンやテスト用） */
export function buyTrain(
  world: World,
  depotId: number,
  wagons: WagonType[],
  opts: { dry?: boolean; orderList?: number; orders?: Order[]; engine?: EngineType } = {},
): CmdResult {
  const depot = world.depots.get(depotId);
  if (!depot) return fail('車庫がありません');
  if (wagons.length === 0) return fail('車両を1両以上つないでください');
  const engine = opts.engine ?? 'steam';
  const bad = consistError(engine, wagons);
  if (bad) return fail(bad);
  const types: VehicleType[] = [engine, ...wagons];
  const locked = types.find((t) => !canBuy(world, t));
  if (locked) return fail(`${vehicleName(locked)}はまだ買えません`);
  const cost = trainCost(types);
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);
  const train = createTrain(
    world,
    depot,
    types.map((t) => newCar(world, t)),
    opts.orderList,
    opts.orders,
  );
  spend(world, 'vehicles', cost);
  return { ok: true, cost, id: train.id };
}

/**
 * 車両を1両買う。
 * - 機関車：その車庫に新しい列車として置く
 * - 貨車：attachTo の列車（車庫で停止中）につなぐ。指定がなければ留置線へ
 */
export function buyVehicle(
  world: World,
  depotId: number,
  type: VehicleType,
  opts: { dry?: boolean; attachTo?: number } = {},
): CmdResult {
  const depot = world.depots.get(depotId);
  if (!depot) return fail('車庫がありません');
  const rule = ruleBlocksVehicle(world, type);
  if (rule) return fail(rule);
  if (!canBuy(world, type)) return fail(`${vehicleName(type)}はまだ買えません（${vehicleYear(type)}年に登場します）`);
  let target: Train | undefined;
  if (!isEngine(type) && opts.attachTo !== undefined && opts.attachTo >= 0) {
    target = world.trains.get(opts.attachTo);
    const err = attachError(depot, target, type);
    if (err) return fail(err);
  }
  const cost = vehicleCost(type);
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${formatYen(cost)} 必要）`, cost);
  const car = newCar(world, type);
  spend(world, 'vehicles', cost);
  if (isEngine(type)) {
    const t = createTrain(world, depot, [car]);
    return { ok: true, cost, id: t.id };
  }
  if (target) target.cars.push(car);
  else depot.stored.push(car);
  return { ok: true, cost, id: car.id };
}

function attachError(depot: Depot, t: Train | undefined, add: VehicleType): string | null {
  if (!t) return '列車がありません';
  if (t.state !== 'in_depot' || t.depotId !== depot.id) return '列車がこの車庫に止まっていません';
  const head = t.cars[0].type;
  if (!isEngine(head)) return null;
  return consistError(head, [...t.cars.slice(1).map((c) => c.type), add]);
}

/** 留置線の貨車を、車庫に止まっている列車の最後尾につなぐ */
export function attachVehicle(world: World, depotId: number, carId: number, trainId: number): CmdResult {
  const depot = world.depots.get(depotId);
  if (!depot) return fail('車庫がありません');
  const i = depot.stored.findIndex((c) => c.id === carId);
  if (i < 0) return fail('留置線にその車両がありません');
  if (isEngine(depot.stored[i].type)) return fail('機関車は「列車にする」で使ってください');
  const t = world.trains.get(trainId);
  const err = attachError(depot, t, depot.stored[i].type);
  if (err) return fail(err);
  t!.cars.push(depot.stored.splice(i, 1)[0]);
  return { ok: true, cost: 0 };
}

/** 車庫に止まっている列車から貨車を外して、留置線に置く */
export function detachVehicle(world: World, trainId: number, carId: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  if (t.state !== 'in_depot') return fail('車庫に入れてから外してください');
  const depot = world.depots.get(t.depotId);
  if (!depot) return fail('車庫がありません');
  const i = t.cars.findIndex((c) => c.id === carId);
  if (i < 0) return fail('その車両はこの列車にありません');
  if (i === 0) return fail('機関車は外せません（列車ごと「ばらす」を使ってください）');
  depot.stored.push(t.cars.splice(i, 1)[0]);
  return { ok: true, cost: 0 };
}

/** 留置線の機関車を新しい列車にする */
export function makeTrain(world: World, depotId: number, carId: number): CmdResult {
  const depot = world.depots.get(depotId);
  if (!depot) return fail('車庫がありません');
  const i = depot.stored.findIndex((c) => c.id === carId);
  if (i < 0) return fail('留置線にその車両がありません');
  if (!isEngine(depot.stored[i].type)) return fail('列車にできるのは機関車だけです');
  const t = createTrain(world, depot, [depot.stored.splice(i, 1)[0]]);
  return { ok: true, cost: 0, id: t.id };
}

/** 車庫に止まっている列車をばらして、すべての車両を留置線に置く（指令は消える） */
export function disbandTrain(world: World, trainId: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  if (t.state !== 'in_depot') return fail('車庫に入れてからばらしてください');
  const depot = world.depots.get(t.depotId);
  if (!depot) return fail('車庫がありません');
  depot.stored.push(...t.cars);
  removeTrain(world, t);
  return { ok: true, cost: 0 };
}

export function carValue(world: World, car: Car): number {
  return vehicleValue(car.type, world.day - car.built);
}

/** 留置線の車両を売る */
export function sellVehicle(world: World, depotId: number, carId: number): CmdResult {
  const depot = world.depots.get(depotId);
  if (!depot) return fail('車庫がありません');
  const i = depot.stored.findIndex((c) => c.id === carId);
  if (i < 0) return fail('留置線にその車両がありません');
  const value = carValue(world, depot.stored[i]);
  depot.stored.splice(i, 1);
  earn(world, 'vehicles', value);
  return { ok: true, cost: -value };
}

export function trainTypes(train: Train): VehicleType[] {
  return train.cars.map((c) => c.type);
}

export function cloneTrain(
  world: World,
  srcId: number,
  depotId: number,
  share: boolean,
  opts: { dry?: boolean } = {},
): CmdResult {
  const src = world.trains.get(srcId);
  if (!src) return fail('列車がありません');
  const ol = world.orderLists.get(src.orderList)!;
  const types = trainTypes(src);
  const engine = isEngine(types[0]) ? types[0] : 'steam';
  const wagons = types.slice(1).filter((t): t is WagonType => !isEngine(t));
  return buyTrain(world, depotId, wagons, {
    dry: opts.dry,
    engine,
    orderList: share ? ol.id : undefined,
    orders: share ? undefined : ol.orders,
  });
}

export function trainValue(world: World, train: Train): number {
  return train.cars.reduce((s, c) => s + carValue(world, c), 0);
}

/** 列車ごと売る（車庫に止まっているとき） */
export function sellTrain(world: World, id: number): CmdResult {
  const t = world.trains.get(id);
  if (!t) return fail('列車がありません');
  if (t.state !== 'in_depot') return fail('車庫に入れてから売却してください');
  const value = trainValue(world, t);
  removeTrain(world, t);
  earn(world, 'vehicles', value);
  return { ok: true, cost: -value };
}

export function startStop(world: World, id: number): CmdResult {
  const t = world.trains.get(id);
  if (!t) return fail('列車がありません');
  const orders = world.orderLists.get(t.orderList)!.orders;
  switch (t.state) {
    case 'in_depot': {
      if (orders.length === 0) return fail('指令がありません（「指令」から行き先を追加してください）');
      const depot = world.depots.get(t.depotId);
      if (!depot) return fail('車庫がありません');
      t.state = 'running';
      t.heading = 'order';
      t.path = [depot.tile];
      t.progress = 0;
      t.trail = [];
      t.trackVersion = -1;
      return { ok: true, cost: 0 };
    }
    case 'stopped':
      t.state = t.stoppedAt >= 0 ? 'loading' : 'running';
      t.trackVersion = -1;
      return { ok: true, cost: 0 };
    default:
      t.state = 'stopped';
      return { ok: true, cost: 0 };
  }
}

export function sendToDepot(world: World, id: number): CmdResult {
  const t = world.trains.get(id);
  if (!t) return fail('列車がありません');
  if (t.state === 'in_depot') return fail('もう車庫にいます');
  if (world.depots.size === 0) return fail('車庫がありません（線路の隣に車庫を建ててください）');
  t.heading = t.heading === 'depot' ? 'order' : 'depot';
  if (t.heading === 'order') t.engineSwap = null;
  t.trackVersion = -1;
  if (t.state === 'loading') {
    t.state = 'running';
    t.stoppedAt = -1;
  }
  return { ok: true, cost: 0 };
}

// ───────────────────────── 指令 ─────────────────────────

function sharers(world: World, olId: number): Train[] {
  return [...world.trains.values()].filter((t) => t.orderList === olId);
}

export function addOrder(
  world: World,
  trainId: number,
  stationId: number,
  load: LoadMode = 'if_available',
  insertAt?: number,
): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  if (!world.stations.has(stationId)) return fail('駅がありません');
  const ol = world.orderLists.get(t.orderList)!;
  const at = insertAt === undefined ? ol.orders.length : Math.max(0, Math.min(insertAt, ol.orders.length));
  const prev = ol.orders[(at - 1 + ol.orders.length) % Math.max(1, ol.orders.length)];
  if (ol.orders.length > 0 && prev && prev.station === stationId) return fail('同じ駅が続いています');
  if (ol.orders.length >= 30) return fail('指令は30個までです');
  ol.orders.splice(at, 0, { station: stationId, load, unload: 'if_accepted' });
  for (const tr of sharers(world, ol.id)) {
    if (tr.curOrder >= at && ol.orders.length > 1) tr.curOrder++;
    if (tr.curOrder >= ol.orders.length) tr.curOrder = 0;
  }
  return { ok: true, cost: 0 };
}

export function deleteOrder(world: World, trainId: number, index: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  const ol = world.orderLists.get(t.orderList)!;
  if (index < 0 || index >= ol.orders.length) return fail('指令がありません');
  ol.orders.splice(index, 1);
  for (const tr of sharers(world, ol.id)) {
    if (tr.curOrder > index) tr.curOrder--;
    else if (tr.curOrder === index) tr.trackVersion = -1;
    if (tr.curOrder >= ol.orders.length) tr.curOrder = 0;
    if (ol.orders.length === 0 && tr.state !== 'in_depot') {
      if (tr.state === 'loading') tr.state = 'running';
      tr.heading = 'depot';
      tr.trackVersion = -1;
    }
  }
  return { ok: true, cost: 0 };
}

export function setOrderLoad(world: World, trainId: number, index: number, load: LoadMode): CmdResult {
  const o = getOrder(world, trainId, index);
  if (!o) return fail('指令がありません');
  o.load = load;
  return { ok: true, cost: 0 };
}

export function setOrderUnload(world: World, trainId: number, index: number, unload: UnloadMode): CmdResult {
  const o = getOrder(world, trainId, index);
  if (!o) return fail('指令がありません');
  o.unload = unload;
  return { ok: true, cost: 0 };
}

export function skipOrder(world: World, trainId: number, to?: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  const n = world.orderLists.get(t.orderList)!.orders.length;
  if (n === 0) return fail('指令がありません');
  t.curOrder = to !== undefined ? to % n : (t.curOrder + 1) % n;
  t.trackVersion = -1;
  if (t.state === 'loading') {
    t.state = 'running';
    t.stoppedAt = -1;
  }
  return { ok: true, cost: 0 };
}

// ───────────────────────── 名前・指令の並べ替え ─────────────────────────

export type NamedKind = 'station' | 'train' | 'town' | 'industry';
export const MAX_NAME = 20;

/** 駅・列車・町・産業の名前を変える */
export function rename(world: World, kind: NamedKind, id: number, name: string): CmdResult {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) return fail('名前を入れてください');
  if ([...n].length > MAX_NAME) return fail(`名前は${MAX_NAME}文字までです`);
  const target =
    kind === 'station' ? world.stations.get(id) : kind === 'train' ? world.trains.get(id) : kind === 'town' ? world.towns.get(id) : world.industries.get(id);
  if (!target) return fail('見つかりません');
  target.name = n;
  if (kind === 'town') (target as { custom?: boolean }).custom = true;
  world.version++;
  return { ok: true, cost: 0 };
}

/** 指令を上（-1）か下（+1）に動かす。共有している列車の「今の指令」もいっしょに動く */
export function moveOrder(world: World, trainId: number, index: number, to: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  const ol = world.orderLists.get(t.orderList)!;
  const n = ol.orders.length;
  if (index < 0 || index >= n || to < 0 || to >= n || index === to) return fail('動かせません');
  const [o] = ol.orders.splice(index, 1);
  ol.orders.splice(to, 0, o);
  for (const tr of sharers(world, ol.id)) {
    const c = tr.curOrder;
    if (c === index) tr.curOrder = to;
    else if (index < c && to >= c) tr.curOrder = c - 1;
    else if (index > c && to <= c) tr.curOrder = c + 1;
    tr.trackVersion = -1;
  }
  return { ok: true, cost: 0 };
}

// ───────────────────────── 機関車の交換 ─────────────────────────

/**
 * 車庫にいる列車の機関車だけを替える（貨車と指令はそのまま）。
 * 留置線に同じ種類の機関車があればそれを使い、なければ買う。古い機関車は留置線に置くか売る
 */
export function replaceEngine(
  world: World,
  trainId: number,
  type: EngineType,
  opts: { sellOld?: boolean; dry?: boolean } = {},
): CmdResult {
  const t = world.trains.get(trainId);
  if (!t) return fail('列車がありません');
  if (t.state !== 'in_depot') return fail('車庫に入れてから交換してください');
  const depot = world.depots.get(t.depotId);
  if (!depot) return fail('車庫がありません');
  const old = t.cars[0];
  if (old.type === type) return fail(`もう${vehicleName(type)}です`);
  const bad = consistError(type, t.cars.slice(1).map((c) => c.type));
  if (bad) return fail(bad);
  const spare = depot.stored.find((c) => c.type === type);
  if (!spare && !canBuy(world, type)) return fail(`${vehicleName(type)}はまだ買えません`);
  const cost = spare ? 0 : vehicleCost(type);
  const refund = opts.sellOld ? carValue(world, old) : 0;
  if (opts.dry) return { ok: true, cost: cost - refund };
  if (cost > world.money + refund) return fail(`資金が足りません（${formatYen(cost - refund)} 必要）`, cost);
  if (spare) depot.stored.splice(depot.stored.indexOf(spare), 1);
  else spend(world, 'vehicles', cost);
  t.cars[0] = spare ?? newCar(world, type);
  if (opts.sellOld) earn(world, 'vehicles', refund);
  else depot.stored.push(old);
  return { ok: true, cost: cost - refund };
}

/**
 * まとめて機関車を替える。車庫にいる列車はすぐ、走っている列車は
 * いちばん近い車庫に入ったときに替えて、そのまま元の指令で走り出す
 */
export function scheduleEngineSwap(
  world: World,
  trainIds: number[],
  type: EngineType,
  sellOld: boolean,
): CmdResult & { now?: number; later?: number } {
  if (!canBuy(world, type) && ![...world.depots.values()].some((d) => d.stored.some((c) => c.type === type))) {
    return fail(`${vehicleName(type)}はまだ買えません`);
  }
  let now = 0,
    later = 0,
    cost = 0;
  let lastError = '';
  for (const id of trainIds) {
    const t = world.trains.get(id);
    if (!t || t.cars[0]?.type === type) continue;
    const bad = consistError(type, t.cars.slice(1).map((c) => c.type));
    if (bad) {
      lastError = bad;
      continue;
    }
    if (t.state === 'in_depot') {
      const r = replaceEngine(world, id, type, { sellOld });
      if (r.ok) {
        now++;
        cost += r.cost;
      } else lastError = r.error ?? '';
      continue;
    }
    if (!world.depots.size) return fail('車庫がありません（線路の隣に車庫を建ててください）');
    t.engineSwap = { type, sellOld };
    t.heading = 'depot';
    t.trackVersion = -1;
    if (t.state === 'loading') {
      t.state = 'running';
      t.stoppedAt = -1;
    }
    later++;
  }
  if (!now && !later) return fail(lastError || '交換する列車がありません');
  return { ok: true, cost, now, later };
}

/** 交換待ちを取りやめる（元の指令に戻る） */
export function cancelEngineSwap(world: World, trainId: number): CmdResult {
  const t = world.trains.get(trainId);
  if (!t?.engineSwap) return fail('交換待ちではありません');
  t.engineSwap = null;
  if (t.heading === 'depot') {
    t.heading = 'order';
    t.trackVersion = -1;
  }
  return { ok: true, cost: 0 };
}

/** その駅に止まる列車（指令を共有している列車はまとめる） */
export function stationTrains(world: World, stationId: number): { orderList: number; trains: Train[] }[] {
  const out = new Map<number, Train[]>();
  for (const t of world.trains.values()) {
    const ol = world.orderLists.get(t.orderList);
    if (!ol || !ol.orders.some((o) => o.station === stationId)) continue;
    const arr = out.get(ol.id) ?? [];
    arr.push(t);
    out.set(ol.id, arr);
  }
  return [...out].map(([orderList, trains]) => ({ orderList, trains }));
}

/**
 * 指令の中の駅を、別の駅に差し替える（駅を解体する前などに）。
 * orderLists を省くと、その駅を使うすべての指令が対象。差し替えで同じ駅が続いたら1つにまとめる
 */
export function replaceStationInOrders(
  world: World,
  from: number,
  to: number,
  orderLists?: number[],
): CmdResult & { count?: number } {
  if (from === to) return fail('同じ駅です');
  if (!world.stations.has(to)) return fail('駅がありません');
  const targets = orderLists ?? stationTrains(world, from).map((g) => g.orderList);
  let count = 0;
  for (const olId of targets) {
    const ol = world.orderLists.get(olId);
    if (!ol) continue;
    for (const o of ol.orders) {
      if (o.station !== from) continue;
      o.station = to;
      o.dest = null;
      o.split = null;
      count++;
    }
    // 同じ駅が続いたら1つにまとめる（最後と最初も）
    for (let i = ol.orders.length - 1; i > 0; i--) {
      if (ol.orders[i].station === ol.orders[i - 1].station) ol.orders.splice(i, 1);
    }
    while (ol.orders.length > 1 && ol.orders[0].station === ol.orders[ol.orders.length - 1].station) ol.orders.pop();
    for (const t of sharers(world, olId)) {
      if (t.curOrder >= ol.orders.length) t.curOrder = 0;
      t.trackVersion = -1;
      if (t.state === 'loading' && t.stoppedAt === from) {
        t.state = 'running';
        t.stoppedAt = -1;
      }
    }
  }
  if (!count) return fail('差し替える指令がありません');
  return { ok: true, cost: 0, count };
}

/** 振り分けの割合を決める（null なら振り分けない） */
export function setOrderSplit(world: World, trainId: number, index: number, split: (Dest & { w: number })[] | null): CmdResult {
  const o = getOrder(world, trainId, index);
  if (!o) return fail('指令がありません');
  o.split = split && split.some((s) => s.w > 0) ? split : null;
  if (o.split) o.dest = null;
  return { ok: true, cost: 0 };
}

/** 届け先を選ぶ（null ならいちばん近い受け入れ先） */
export function setOrderDest(world: World, trainId: number, index: number, dest: Dest | null): CmdResult {
  const o = getOrder(world, trainId, index);
  if (!o) return fail('指令がありません');
  o.dest = dest;
  o.split = null;
  return { ok: true, cost: 0 };
}

function getOrder(world: World, trainId: number, index: number): Order | null {
  const t = world.trains.get(trainId);
  if (!t) return null;
  return world.orderLists.get(t.orderList)!.orders[index] ?? null;
}
