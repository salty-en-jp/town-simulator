// 時間を進める：列車の移動・積み降ろし、毎日の生産と町の成長、毎月のお金

import { comfortMul, develDaily, hasMaker, MAKER } from './devel';
import { salesMonthly, salesYearly } from './sales';
import { techMonthly } from './tech';
import {
  CARGOS,
  COSTS,
  ENGINE_SPECS,
  ENGINE_TYPES,
  HOUSE_PAX_PER_DAY,
  HOUSE_POP,
  INDUSTRY,
  INDUSTRY_SPECS,
  STATION,
  vehicleName,
  vehicleValue,
  TICKS_PER_DAY,
  TOWN,
  TOWN_GOODS,
  isEngine,
  WAGON_SPECS,
  WAGON_TYPES,
  type Cargo,
  type VehicleType,
} from './constants';
import { cargoIncome, demandFactor } from './economy';
import { replaceEngine } from './commands';
import { companyMonthly } from './company';
import { eventsMonthly } from './events';
import { addFame, famePaxMul, isHomeSpecialty, specialtyBonus, specialtyDaily, specialtyMonthly } from './specialty';
import { intercityMul, TOWN_GROWTH, townAccepts, townNear, townStage, updateTownStage } from './towns';
import { boomMul, marketIndex, marketMonthly, tourismPaxMul } from './market';
import { industriesOwnershipDaily, industriesOwnershipMonthly } from './industries';
import { updateRequests } from './requests';
import { findPath } from './track';
import {
  carCapacity,
  carCargo,
  carLoad,
  connected,
  dateOf,
  dirBetween,
  earn,
  emptyFinance,
  canLoadFrom,
  idx,
  inBounds,
  isPrimary,
  manhattan,
  pushEvent,
  pushHist,
  recvOf,
  rectContains,
  rectOverlapsIndustry,
  spend,
  stationCatchment,
  stationSign,
  Terrain,
  trainSpeed,
  trainEngine,
  tx,
  ty,
  vehicleYear,
  type Dest,
  type Industry,
  type Rect,
  type Station,
  type Town,
  type Train,
  type World,
  needsWire,
  paceMul,
  ELECTRIFY_YEAR,
  townLabel,
} from './world';

// ───────────────────────── 受け入れ判定（キャッシュ付き） ─────────────────────────

/** 貨物の受け入れ先（産業か町）。dist は駅の看板からの距離 */
export interface Acceptor {
  kind: 'industry' | 'town';
  id: number;
  dist: number;
}

export interface Acceptance {
  /** 集客範囲にある家の数 */
  houses: number;
  /** 貨物ごとの受け入れ先（近い順） */
  by: Partial<Record<Cargo, Acceptor[]>>;
}

const acceptCache = new WeakMap<World, { version: number; map: Map<number, Acceptance> }>();

export function acceptance(world: World, st: Station): Acceptance {
  let c = acceptCache.get(world);
  if (!c || c.version !== world.version) {
    c = { version: world.version, map: new Map() };
    acceptCache.set(world, c);
  }
  const hit = c.map.get(st.id);
  if (hit) return hit;
  const sign = stationSign(st);
  const acc = acceptanceForRect(world, stationCatchment(world, st), tx(world, sign), ty(world, sign));
  c.map.set(st.id, acc);
  return acc;
}

/** 範囲（駅の集客範囲など）で受け入れる貨物と、その受け入れ先。(sx, sy) は駅の看板の位置 */
export function acceptanceForRect(world: World, r: Rect, sx: number, sy: number): Acceptance {
  let houses = 0;
  const towns = new Map<number, { n: number; dist: number }>();
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const o = world.occ[idx(world, x, y)];
      if (o?.k !== 'house') continue;
      houses++;
      const d = Math.abs(x - sx) + Math.abs(y - sy);
      const e = towns.get(o.town) ?? { n: 0, dist: Infinity };
      e.n++;
      e.dist = Math.min(e.dist, d);
      towns.set(o.town, e);
    }
  }
  const by: Partial<Record<Cargo, Acceptor[]>> = {};
  const add = (cargo: Cargo, a: Acceptor) => (by[cargo] ??= []).push(a);
  for (const ind of world.industries.values()) {
    const inputs = INDUSTRY_SPECS[ind.type].inputs;
    if (!inputs.length || ind.status !== 'active' || !rectOverlapsIndustry(r, ind)) continue;
    const d = Math.abs(ind.x + (ind.w - 1) / 2 - sx) + Math.abs(ind.y + (ind.h - 1) / 2 - sy);
    for (const cargo of inputs) add(cargo, { kind: 'industry', id: ind.id, dist: d });
  }
  for (const [id, e] of towns) {
    if (e.n >= 2) add('passengers', { kind: 'town', id, dist: e.dist });
    for (const cargo of TOWN_GOODS) if (townAccepts(world, id, cargo)) add(cargo, { kind: 'town', id, dist: e.dist });
  }
  for (const list of Object.values(by)) list!.sort((p, q) => p.dist - q.dist);
  return { houses, by };
}

/** 範囲から集められる貨物：産業（運べるかどうかも）と、家から出る旅客 */
export function suppliesForRect(world: World, r: Rect): { industries: Industry[]; houses: number; paxPerMonth: number } {
  const industries = [...world.industries.values()].filter((ind) => rectOverlapsIndustry(r, ind));
  let houses = 0,
    pax = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const o = world.occ[idx(world, x, y)];
      if (o?.k !== 'house') continue;
      houses++;
      pax += HOUSE_PAX_PER_DAY[o.level] * 30;
    }
  }
  return { industries, houses, paxPerMonth: Math.round(pax) };
}

export function acceptors(world: World, st: Station, cargo: Cargo): Acceptor[] {
  return acceptance(world, st).by[cargo] ?? [];
}

export function acceptorName(world: World, a: { kind: 'industry' | 'town'; id: number }): string {
  return a.kind === 'industry' ? (world.industries.get(a.id)?.name ?? '?') : (world.towns.has(a.id) ? townLabel(world.towns.get(a.id)!) : '?');
}

/** 受け入れ先の今の在庫（多いほど安く買う） */
export function acceptorStock(world: World, a: { kind: 'industry' | 'town'; id: number }, cargo: Cargo): number {
  if (a.kind === 'industry') return world.industries.get(a.id)?.inputs[cargo] ?? 0;
  return world.towns.get(a.id)?.stock[cargo] ?? 0;
}

/** 受け入れ先の買取係数（在庫が少ないほど高い。旅客は 1） */
export function acceptorDemand(world: World, a: { kind: 'industry' | 'town'; id: number }, cargo: Cargo): number {
  const boom = boomMul(world, a, cargo);
  if (cargo === 'passengers') return boom;
  // 名産品は、大きな町ほど高く買う
  const sp = cargo === 'specialty' && a.kind === 'town' ? specialtyBonus(world.towns.get(a.id)) : 1;
  return demandFactor(acceptorStock(world, a, cargo), a.kind === 'industry' ? INDUSTRY.stockCap : TOWN.stockCap) * marketIndex(world, cargo) * boom * sp;
}

// ───────────────────────── 列車 ─────────────────────────

function goalsFor(world: World, t: Train): Set<number> | null {
  if (t.heading === 'depot') {
    // いちばん近い車庫へ（OpenTTD と同じ）。買った車庫が撤去されていても帰れる
    if (world.depots.size === 0) return null;
    return new Set([...world.depots.values()].map((d) => d.tile));
  }
  const orders = world.orderLists.get(t.orderList)!.orders;
  if (orders.length === 0) return null;
  const st = world.stations.get(orders[t.curOrder % orders.length].station);
  return st ? new Set(st.tiles) : null;
}

function ensurePath(world: World, t: Train) {
  if (t.trackVersion === world.trackVersion) return;
  t.trackVersion = world.trackVersion;
  const goals = goalsFor(world, t);
  const here = t.path[0];
  if (!goals) {
    t.path = [here];
    t.progress = 0;
    t.state = 'no_path';
    return;
  }
  // 走行中のタイル間がまだつながっていれば、その先から探す
  if (t.progress > 0 && t.path.length > 1) {
    const next = t.path[1];
    const d = dirBetween(world, here, next);
    if (d && connected(world, here, d) === next) {
      const p = goals.has(next) ? [next] : findPath(world, next, goals, needsWire(t));
      if (p) {
        t.path = [here, ...p];
        t.state = 'running';
        return;
      }
    }
  }
  t.progress = 0;
  const p = findPath(world, here, goals, needsWire(t));
  if (p) {
    t.path = p;
    t.state = 'running';
  } else {
    t.path = [here];
    t.state = 'no_path';
  }
}

function arrive(world: World, t: Train) {
  const tile = t.path[0];
  if (t.heading === 'depot') {
    const o = world.occ[tile];
    const d = o?.k === 'depot' ? world.depots.get(o.id) : undefined;
    if (d) {
      // 入った車庫を、この列車の車庫にする
      t.depotId = d.id;
      t.state = 'in_depot';
      t.heading = 'order';
      t.trail = [];
      t.trackVersion = -1;
      if (t.engineSwap) {
        // 機関車を交換して、そのまま元の指令で走り出す
        const swap = t.engineSwap;
        const r = replaceEngine(world, t.id, swap.type, { sellOld: swap.sellOld });
        if (r.ok) {
          t.engineSwap = null;
          t.state = 'running';
          t.path = [tile];
          t.progress = 0;
          pushEvent(world, { type: 'news', text: `${t.name}の機関車を${vehicleName(swap.type)}に交換しました`, tone: 'good', tile });
        } else {
          pushEvent(world, { type: 'news', text: `${t.name}：機関車を交換できませんでした（${r.error}）。車庫で止まっています`, tone: 'bad', tile });
        }
        return;
      }
      pushEvent(world, { type: 'news', text: `${t.name}が車庫に入りました`, tone: 'info', tile });
      return;
    }
  }
  const o = world.occ[tile];
  if (o?.k === 'station') {
    const st = world.stations.get(o.id)!;
    t.state = 'loading';
    t.stoppedAt = st.id;
    t.loadTimer = 0;
    t.incomeThisStop = 0;
    st.daysSinceVisit = 0;
    if (!world.firstArrivals.has(st.id)) {
      world.firstArrivals.add(st.id);
      pushEvent(world, {
        type: 'news',
        text: `祝！ ${st.name}に初めての列車が到着しました`,
        tone: 'good',
        tile: stationSign(st),
      });
    }
    return;
  }
  t.trackVersion = -1; // 行き先に着いていない（経路が変わった等）→ 探し直し
}

/** 指令で選んだ届け先（なければいちばん近い受け入れ先） */
export function chooseAcceptor(world: World, st: Station, cargo: Cargo, dest?: Dest | null): Acceptor | null {
  const list = acceptors(world, st, cargo);
  if (!list.length) return null;
  if (dest) {
    const hit = list.find((a) => a.kind === dest.kind && a.id === dest.id);
    if (hit) return hit;
  }
  return list[0];
}

function deliver(world: World, t: Train, st: Station, cargo: Cargo, maxAmount: number, dest?: Dest | null): number {
  const target = chooseAcceptor(world, st, cargo, dest);
  if (!target) return 0;
  let limit = maxAmount;
  const ind = target.kind === 'industry' ? world.industries.get(target.id) : undefined;
  const town = target.kind === 'town' ? world.towns.get(target.id) : undefined;
  if (!ind && !town) return 0;
  if (ind) {
    limit = Math.min(limit, INDUSTRY.stockCap - (ind.inputs[cargo] ?? 0));
    if (limit <= 0.001) return 0;
  }
  const demand = acceptorDemand(world, target, cargo);
  let delivered = 0;
  const sign = stationSign(st);
  for (const car of t.cars) {
    if (carCargo(car) !== cargo) continue;
    for (const p of car.packets) {
      if (p.from === st.id || p.amount <= 0) continue;
      // 名産品は、生まれた町では売れない（積んだまま、ほかの町へ）
      if (cargo === 'specialty' && town && isHomeSpecialty(world, p.fromTile, town)) continue;
      const take = Math.min(p.amount, limit - delivered);
      if (take <= 0) break;
      p.amount -= take;
      delivered += take;
      // 旅客：大きな町どうしを結ぶほど運賃が上がる（乗った町と降りた町の大きさ）
      const inter = cargo === 'passengers' && town ? intercityMul(townNear(world, p.fromTile), town) : 1;
      // 実績のための数え
      const stats = (world.stats ??= {});
      (stats.cargo ??= {})[cargo] = (stats.cargo[cargo] ?? 0) + take;
      if (boomMul(world, target, cargo) > 1) stats.boomTons = (stats.boomTons ?? 0) + take;
      if (inter >= 1.5) stats.intercityPax = (stats.intercityPax ?? 0) + take;
      // 快適な自社開発の機関車は、旅客の運賃が上がる
      const comfort = cargo === 'passengers' ? comfortMul(trainEngine(t)) : 1;
      const income = cargoIncome(cargo, take, manhattan(world, p.fromTile, sign), p.days, demand * inter * comfort);
      if (cargo === 'passengers') stats.paxIncome = (stats.paxIncome ?? 0) + income;
      earn(world, 'income', income);
      world.requestState.incomeTotal += income;
      t.incomeThisStop += income;
      t.profitThisYear += income;
      t.profitThisMonth += income;
    }
    car.packets = car.packets.filter((p) => p.amount > 0.0001);
    if (delivered >= limit) break;
  }
  if (delivered > 0) {
    if (ind) {
      ind.inputs[cargo] = (ind.inputs[cargo] ?? 0) + delivered;
      ind.receivedThisMonth += delivered;
      ind.receivedTotal += delivered;
    } else if (town) {
      if (cargo !== 'passengers') town.stock[cargo] = (town.stock[cargo] ?? 0) + delivered;
      const rc = recvOf(town, cargo);
      rc.m += delivered;
      rc.total += delivered;
    }
  }
  return delivered;
}

/**
 * 振り分けて降ろす：受け入れ先ごとの割合で分ける。
 * 受け入れ先がいっぱいで入りきらない分は、ほかの振り分け先に回す
 */
function deliverSplit(world: World, t: Train, st: Station, cargo: Cargo, maxAmount: number, split: (Dest & { w: number })[]): number {
  const list = acceptors(world, st, cargo);
  const targets = split.filter((s) => s.w > 0 && list.some((a) => a.kind === s.kind && a.id === s.id));
  if (!targets.length) return deliver(world, t, st, cargo, maxAmount, null);
  const sum = targets.reduce((a, s) => a + s.w, 0);
  let done = 0;
  for (const s of targets) done += deliver(world, t, st, cargo, (maxAmount * s.w) / sum, s);
  for (const s of targets) {
    if (done >= maxAmount - 0.001) break;
    done += deliver(world, t, st, cargo, maxAmount - done, s);
  }
  return done;
}

function cargoesOf(t: Train): Cargo[] {
  const s = new Set<Cargo>();
  for (const car of t.cars) {
    const c = carCargo(car);
    if (c) s.add(c);
  }
  return [...s];
}

function isFull(t: Train, cargo: Cargo): boolean {
  return t.cars.every((car) => carCargo(car) !== cargo || carLoad(car) >= carCapacity(car, cargo) - 0.001);
}

function loadingTick(world: World, t: Train, dt: number) {
  const st = world.stations.get(t.stoppedAt);
  const orders = world.orderLists.get(t.orderList)!.orders;
  const order = orders[t.curOrder % Math.max(1, orders.length)];
  if (!st || !order || order.station !== st.id) {
    depart(world, t, st);
    return;
  }
  t.loadTimer += dt;
  const perCar = STATION.loadPerDay * dt;
  let busy = false;

  if (order.unload === 'if_accepted') {
    for (const cargo of cargoesOf(t)) {
      const nCars = t.cars.filter((c) => carCargo(c) === cargo).length;
      const amount = perCar * nCars;
      const got = order.split?.length ? deliverSplit(world, t, st, cargo, amount, order.split) : deliver(world, t, st, cargo, amount, order.dest);
      if (got > 0) busy = true;
    }
  }

  if (!busy && order.load !== 'none') {
    const speed = trainSpeed(t);
    for (const car of t.cars) {
      const cargo = carCargo(car);
      if (!cargo) continue;
      const g = st.goods[cargo];
      g.visited = true;
      g.daysSincePickup = 0;
      g.lastSpeed = speed;
      const space = carCapacity(car, cargo) - carLoad(car);
      const amt = Math.min(space, perCar, g.waiting);
      if (amt <= 0.0001) continue;
      g.waiting -= amt;
      const last = car.packets[car.packets.length - 1];
      if (last && last.from === st.id && last.days < 0.01) last.amount += amt;
      else car.packets.push({ amount: amt, from: st.id, fromTile: stationSign(st), days: 0 });
      busy = true;
    }
  }

  if (busy || t.loadTimer < 0.5) return;
  const cargos = cargoesOf(t);
  let done = true;
  if (order.load === 'full_any') done = cargos.some((c) => isFull(t, c));
  else if (order.load === 'full_all') done = cargos.every((c) => isFull(t, c));
  if (done) depart(world, t, st);
}

function depart(world: World, t: Train, st: Station | undefined) {
  if (st && t.incomeThisStop > 0) {
    pushEvent(world, { type: 'income', amount: t.incomeThisStop, tile: stationSign(st) });
  }
  t.incomeThisStop = 0;
  t.stoppedAt = -1;
  t.state = 'running';
  const n = world.orderLists.get(t.orderList)!.orders.length;
  if (n > 0) t.curOrder = (t.curOrder + 1) % n;
  t.trackVersion = -1;
}

function trainTick(world: World, t: Train, dt: number) {
  if (t.state === 'in_depot' || t.state === 'stopped') return;
  for (const car of t.cars) {
    if (!car.packets.length) continue;
    // 新型冷蔵車などは荷物が傷みにくい（日数がゆっくり進む）
    const f = isEngine(car.type) ? 1 : (WAGON_SPECS[car.type].fresh ?? 1);
    for (const p of car.packets) p.days += dt * f;
  }
  if (t.state === 'loading') {
    loadingTick(world, t, dt);
    return;
  }
  ensurePath(world, t);
  if (t.state === 'no_path') return;
  let move = trainSpeed(t) * dt;
  while (move > 0 && t.path.length > 1) {
    const rem = 1 - t.progress;
    if (move < rem) {
      t.progress += move;
      move = 0;
    } else {
      move -= rem;
      t.progress = 0;
      t.trail.unshift(t.path.shift()!);
      if (t.trail.length > 12) t.trail.length = 12;
    }
  }
  if (t.path.length === 1) arrive(world, t);
}

// ───────────────────────── 毎日の処理 ─────────────────────────

interface DayContext {
  rects: Map<number, Rect>;
  housesByTown: Map<number, number[]>;
}

function bestStations(world: World, ctx: DayContext, cargo: Cargo, test: (r: Rect) => boolean): Station[] {
  const out: Station[] = [];
  for (const st of world.stations.values()) {
    if (!st.goods[cargo].visited) continue;
    if (test(ctx.rects.get(st.id)!)) out.push(st);
  }
  out.sort((a, b) => b.goods[cargo].rating - a.goods[cargo].rating);
  return out.slice(0, 2);
}

/** 産業や家から駅へ貨物を渡す（駅の評価が高いほど多く渡す） */
function handToStations(cands: Station[], cargo: Cargo, amount: number): number {
  if (cands.length === 0 || amount <= 0) return 0;
  const r1 = cands[0].goods[cargo].rating;
  const moved = (amount * r1) / 255;
  if (cands.length === 1) {
    cands[0].goods[cargo].waiting += moved;
  } else {
    const r2 = cands[1].goods[cargo].rating;
    const share = r1 / (r1 + r2);
    cands[0].goods[cargo].waiting += moved * share;
    cands[1].goods[cargo].waiting += moved * (1 - share);
  }
  return moved;
}

function industriesDaily(world: World, ctx: DayContext) {
  for (const ind of world.industries.values()) {
    if (ind.status !== 'active') continue;
    const spec = INDUSTRY_SPECS[ind.type];
    const perDay = ind.prodRate / 30;
    const room = Math.max(0, INDUSTRY.stockCap - ind.outStock);
    if (spec.inputs.length === 0) {
      const p = Math.min(perDay, room);
      ind.outStock += p;
      ind.producedThisMonth += p;
    } else if (spec.anyInput) {
      // どれか1つの材料でよい工場（食品工場）：ある材料を合わせて使う。多い材料から先に使う
      const total = spec.inputs.reduce((n, c) => n + (ind.inputs[c] ?? 0), 0);
      let conv = Math.max(0, Math.min(total, perDay, room));
      ind.outStock += conv;
      ind.producedThisMonth += conv;
      for (const c of [...spec.inputs].sort((a, b) => (ind.inputs[b] ?? 0) - (ind.inputs[a] ?? 0))) {
        const use = Math.min(ind.inputs[c] ?? 0, conv);
        ind.inputs[c] = (ind.inputs[c] ?? 0) - use;
        conv -= use;
      }
    } else {
      // 材料が2つ以上いる工場は、いちばん少ない材料の分しか作れない（全部そろってフル生産）
      const have = Math.min(...spec.inputs.map((c) => ind.inputs[c] ?? 0));
      const conv = Math.max(0, Math.min(have, perDay, room));
      for (const c of spec.inputs) ind.inputs[c] = (ind.inputs[c] ?? 0) - conv;
      ind.outStock += conv;
      ind.producedThisMonth += conv;
    }
    const cargo = spec.output;
    // 他社の産業（権利も契約もない）からは、駅に貨物が来ない
    if (!canLoadFrom(world, ind)) continue;
    const cands = bestStations(world, ctx, cargo, (r) => rectOverlapsIndustry(r, ind));
    const moved = handToStations(cands, cargo, ind.outStock);
    ind.outStock -= moved;
    ind.transportedThisMonth += moved;
    ind.transportedTotal += moved;
    if (ind.type === 'workshop' && moved > 0) addFame(world, ind, moved);
  }
}

function housesDaily(world: World, ctx: DayContext) {
  for (const [townId, tiles] of ctx.housesByTown) {
    // 観光ブームと、名産の評判で、旅客が増える
    const mul = tourismPaxMul(world, townId) * famePaxMul(world.towns.get(townId));
    for (const t of tiles) {
      const o = world.occ[t];
      if (o?.k !== 'house') continue;
      const x = tx(world, t),
        y = ty(world, t);
      const cands = bestStations(world, ctx, 'passengers', (r) => rectContains(r, x, y));
      handToStations(cands, 'passengers', HOUSE_PAX_PER_DAY[o.level] * mul);
    }
  }
}

function townCatchesStation(world: World, town: Town, houses: number[], r: Rect): boolean {
  if (rectContains(r, town.cx, town.cy)) return true;
  return houses.some((t) => rectContains(r, tx(world, t), ty(world, t)));
}

function buildableForHouse(world: World, t: number): boolean {
  // 水の上と、山地の岩場には家が建たない
  return world.occ[t] === null && world.track[t] === 0 && world.terrain[t] !== Terrain.Water && world.terrain[t] !== Terrain.Rock;
}

/** 町に家を1軒建てる。駅の集客範囲の中を優先する */
export function growHouse(world: World, town: Town, houses: number[], stationRects: Rect[]): number {
  const n = houses.length;
  const radius = 2 + Math.floor(Math.sqrt(n) * 1.2);
  const occupied = new Set(houses);
  const cands: { t: number; w: number }[] = [];
  let total = 0;
  for (let y = town.cy - radius; y <= town.cy + radius; y++) {
    for (let x = town.cx - radius; x <= town.cx + radius; x++) {
      if (!inBounds(world, x, y)) continue;
      const t = idx(world, x, y);
      if (!buildableForHouse(world, t)) continue;
      const near =
        Math.abs(x - town.cx) + Math.abs(y - town.cy) <= 1 ||
        [-1, 0, 1].some((dy) =>
          [-1, 0, 1].some((dx) => inBounds(world, x + dx, y + dy) && occupied.has(idx(world, x + dx, y + dy))),
        );
      if (!near) continue;
      const inStation = stationRects.some((r) => rectContains(r, x, y));
      const dist = Math.abs(x - town.cx) + Math.abs(y - town.cy);
      const w = (inStation ? 5 : 1) * (1 + 2 / (1 + dist));
      cands.push({ t, w });
      total += w;
    }
  }
  if (cands.length === 0) return -1;
  let r = world.rng.next() * total;
  for (const c of cands) {
    r -= c.w;
    if (r <= 0) {
      world.occ[c.t] = { k: 'house', town: town.id, level: 1, variant: world.rng.int(0, 3) };
      world.terrain[c.t] = Terrain.Grass;
      world.version++;
      return c.t;
    }
  }
  return -1;
}

function upgradeHouse(world: World, town: Town, houses: number[], to: 2 | 3, fromAny = false): boolean {
  const from = to - 1;
  const cands = houses.filter((t) => {
    const o = world.occ[t];
    return o?.k === 'house' && (fromAny ? o.level < to : o.level === from);
  });
  if (cands.length === 0) return false;
  // 町の中心に近い家から建て替える
  cands.sort((a, b) => {
    const da = Math.abs(tx(world, a) - town.cx) + Math.abs(ty(world, a) - town.cy);
    const db = Math.abs(tx(world, b) - town.cx) + Math.abs(ty(world, b) - town.cy);
    return da - db;
  });
  const pickFrom = cands.slice(0, Math.max(1, Math.ceil(cands.length / 3)));
  const t = world.rng.pick(pickFrom);
  const o = world.occ[t];
  if (o?.k !== 'house') return false;
  world.occ[t] = { ...o, level: to };
  world.version++;
  return true;
}

const POP_MILESTONES = [100, 250, 500, 1000, 2000, 5000];

function townsDaily(world: World, ctx: DayContext) {
  for (const town of world.towns.values()) {
    const houses = ctx.housesByTown.get(town.id) ?? [];
    const stationRects: Rect[] = [];
    let active = 0;
    for (const st of world.stations.values()) {
      const r = ctx.rects.get(st.id)!;
      if (!townCatchesStation(world, town, houses, r)) continue;
      stationRects.push(r);
      if (st.daysSinceVisit <= 20) active++;
    }
    town.activeStations = active;
    const before = town.population;

    const stock = town.stock;
    const has = (c: Cargo, n: number) => (stock[c] ?? 0) >= n;
    const use = (c: Cargo, n: number) => (stock[c] = (stock[c] ?? 0) - n);

    // 届いた材料で建てる・建て替える（段階が上がるほど間隔をあけて、ゆっくり育つ）
    const stage = townStage(town);
    const every = Math.max(1, Math.round(TOWN_GROWTH.buildEvery[stage] / paceMul(world)));
    if ((world.day + town.id) % every === 0) {
      if (stage === 2) {
        // 都市：建設資材でビルに建て替える。建て替える家がなければ、新しくビルを建てる
        if (has('materials', TOWN.materialsPerUpgrade3)) {
          if (upgradeHouse(world, town, houses, 3, true)) use('materials', TOWN.materialsPerUpgrade3);
          else if (world.rng.chance(0.5)) {
            const t = growHouse(world, town, houses, stationRects);
            if (t >= 0) {
              const o = world.occ[t];
              if (o?.k === 'house') world.occ[t] = { ...o, level: 3 };
              houses.push(t);
              use('materials', TOWN.materialsPerUpgrade3);
            }
          }
        }
      } else {
        // 町：建設資材でビルに（家の数の2割まで）
        const tall = houses.filter((t) => {
          const o = world.occ[t];
          return o?.k === 'house' && o.level === 3;
        }).length;
        let built = false;
        if (stage === 1 && has('materials', TOWN.materialsPerUpgrade3) && tall < houses.length * TOWN_GROWTH.townMaxTallShare) {
          built = upgradeHouse(world, town, houses, 3);
          if (built) use('materials', TOWN.materialsPerUpgrade3);
        }
        // 木材で家を建てる。町ならアパートにも建て替える
        if (!built && has('lumber', TOWN.lumberPerHouse)) {
          if (stage === 1 && world.rng.chance(0.5) && upgradeHouse(world, town, houses, 2)) {
            use('lumber', TOWN.lumberPerUpgrade2);
          } else {
            const t = growHouse(world, town, houses, stationRects);
            if (t >= 0) {
              houses.push(t);
              use('lumber', TOWN.lumberPerHouse);
            }
          }
        }
      }
    }

    // 食料品：人口に応じて毎日食べる。足りていると町が早く育つ
    const eat = (town.population / 1000) * TOWN.foodPerThousand;
    const food = stock.food ?? 0;
    town.fed = food > 0 && food >= eat * 0.5;
    stock.food = Math.max(0, food - eat);

    // ふだんの成長（使われている駅が多いほど速い。食料品が足りているとさらに速い）
    town.growthTimer -= (town.fed ? 2 : 1) * paceMul(world);
    if (town.growthTimer <= 0) {
      // 大きな町ほど、ふだんの成長はゆっくり（材料を運ぶ意味が大きくなる）
      const base = active === 0 ? 60 : active === 1 ? 20 : active === 2 ? 14 : 9;
      town.growthTimer = Math.round(base * (1 + town.population / 3000));
      if (active > 0 || world.rng.chance(1 / 3)) {
        const t = growHouse(world, town, houses, stationRects);
        if (t >= 0) houses.push(t);
      }
    }

    recountTown(world, town, houses);
    if (updateTownStage(world, town)) world.version++;
    for (const m of POP_MILESTONES) {
      if (before < m && town.population >= m) {
        pushEvent(world, {
          type: 'news',
          text: `${townLabel(town)}の人口が${m.toLocaleString('ja-JP')}人を超えました！`,
          tone: 'good',
          tile: idx(world, town.cx, town.cy),
        });
      }
    }
  }
}

export function recountTown(world: World, town: Town, houses: number[]) {
  let pop = 0;
  let n = 0;
  for (const t of houses) {
    const o = world.occ[t];
    if (o?.k !== 'house') continue;
    pop += HOUSE_POP[o.level];
    n++;
  }
  town.population = pop;
  town.houses = n;
}

export function housesByTown(world: World): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const id of world.towns.keys()) m.set(id, []);
  for (let i = 0; i < world.occ.length; i++) {
    const o = world.occ[i];
    if (o?.k === 'house') m.get(o.town)?.push(i);
  }
  return m;
}

function stationsDaily(world: World) {
  for (const st of world.stations.values()) {
    st.daysSinceVisit = Math.min(999, st.daysSinceVisit + 1);
    for (const c of CARGOS) {
      const g = st.goods[c];
      if (!g.visited) continue;
      const dsp = g.daysSincePickup;
      const w = g.waiting;
      let target = 30;
      target += dsp <= 3 ? 110 : dsp <= 7 ? 80 : dsp <= 14 ? 50 : dsp <= 28 ? 20 : 0;
      target += w <= 50 ? 70 : w <= 150 ? 50 : w <= 400 ? 25 : w <= 1000 ? 0 : -40;
      target += Math.min(45, g.lastSpeed * 9);
      target = Math.max(0, Math.min(255, target));
      g.rating += Math.max(-3, Math.min(3, target - g.rating));
      if (g.rating < 128 && g.waiting > 30) g.waiting -= g.waiting * 0.03 * (1 - g.rating / 128);
      g.waiting = Math.min(g.waiting, 4000);
      g.daysSincePickup = Math.min(255, dsp + 1);
    }
  }
}

function daily(world: World) {
  const rects = new Map<number, Rect>();
  for (const st of world.stations.values()) rects.set(st.id, stationCatchment(world, st));
  const ctx: DayContext = { rects, housesByTown: housesByTown(world) };
  industriesDaily(world, ctx);
  housesDaily(world, ctx);
  townsDaily(world, ctx);
  specialtyDaily(world);
  develDaily(world);
  stationsDaily(world);
  industriesOwnershipDaily(world);
  updateRequests(world);
}

// ───────────────────────── 毎月・毎年 ─────────────────────────

function monthly(world: World) {
  let running = 0;
  for (const t of world.trains.values()) {
    const cost = t.state !== 'in_depot' ? ENGINE_SPECS[trainEngine(t)].runningCostPerYear / 12 : 0;
    running += cost;
    // 列車ごとの毎月の利益（運賃 − 維持費）を記録
    pushHist(t.hist, Math.round(t.profitThisMonth - cost));
    t.profitThisMonth = 0;
  }
  if (running > 0) spend(world, 'running', Math.round(running));
  const depotFee = Math.round((world.depots.size * COSTS.depotPerYear) / 12);
  if (depotFee > 0) spend(world, 'facilities', depotFee);
  const interest = Math.round((world.loan * world.interestRate) / 100 / 12);
  if (interest > 0) spend(world, 'interest', interest);

  for (const ind of world.industries.values()) {
    pushHist(ind.hist.p, Math.round(ind.producedThisMonth));
    pushHist(ind.hist.t, Math.round(ind.transportedThisMonth));
    pushHist(ind.hist.r, Math.round(ind.receivedThisMonth));
    ind.producedLastMonth = ind.producedThisMonth;
    ind.transportedLastMonth = ind.transportedThisMonth;
    ind.receivedLastMonth = ind.receivedThisMonth;
    ind.producedThisMonth = ind.transportedThisMonth = ind.receivedThisMonth = 0;
    if (isPrimary(ind.type) && canLoadFrom(world, ind)) changeProduction(world, ind);
  }
  industriesOwnershipMonthly(world);
  eventsMonthly(world);
  marketMonthly(world);
  salesMonthly(world);
  techMonthly(world);
  specialtyMonthly(world);
  companyMonthly(world);
  recordCompany(world);
  for (const town of world.towns.values()) {
    for (const r of Object.values(town.recv)) {
      r!.lm = r!.m;
      r!.m = 0;
    }
    pushHist((town.popHist ??= []), town.population);
  }
}

/** 会社の毎月の記録：収入・支出・所持金・車両の資産価値 */
function recordCompany(world: World) {
  let income = 0,
    expense = 0;
  for (const v of Object.values(world.monthFin)) {
    if (v > 0) income += v;
    else expense -= v;
  }
  const h = world.history;
  pushHist(h.income, Math.round(income));
  pushHist(h.expense, Math.round(expense));
  pushHist(h.money, Math.round(world.money));
  pushHist(h.assets, Math.round(vehicleAssets(world)));
  world.monthFin = emptyFinance();
  world.monthIndex++;
}

/** 持っている車両の今の値段の合計（減価償却後） */
export function vehicleAssets(world: World): number {
  let v = 0;
  for (const t of world.trains.values()) for (const c of t.cars) v += vehicleValue(c.type, world.day - c.built);
  for (const d of world.depots.values()) for (const c of d.stored) v += vehicleValue(c.type, world.day - c.built);
  return v;
}

/** 輸送率（運び出された割合）が高いほど生産が増えやすい */
function changeProduction(world: World, ind: Industry) {
  if (!world.rng.chance(paceMul(world) / 8)) return;
  const pct = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0;
  const pUp = pct > 0.8 ? 5 / 6 : pct > 0.6 ? 2 / 3 : 1 / 3;
  const up = world.rng.chance(pUp);
  const delta = Math.max(1, Math.round((ind.prodRate * world.rng.int(10, 60)) / 256));
  const old = ind.prodRate;
  ind.prodRate = Math.max(8, Math.min(512, old + (up ? delta : -delta)));
  const pctChange = Math.round(((ind.prodRate - old) / old) * 100);
  if (Math.abs(pctChange) >= 10) {
    pushEvent(world, {
      type: 'news',
      text: `${ind.name}の生産量が${up ? '増えました' : '減りました'}（${pctChange > 0 ? '+' : ''}${pctChange}%）`,
      tone: up ? 'good' : 'bad',
      tile: idx(world, ind.x + 1, ind.y + 1),
    });
  }
}

function yearly(world: World) {
  // 新型車両の登場
  const y = dateOf(world.day).y;
  if (y === MAKER.year && !hasMaker(world))
    pushEvent(world, {
      type: 'news',
      text: `ツナグ社が車両部門を売りに出しました。${Math.round(MAKER.price / 1e4).toLocaleString('ja-JP')}万円で買い取ると、自社開発で機関車をつくれます（メニューの「自社開発」）`,
      tone: 'good',
    });
  if (y === ELECTRIFY_YEAR) pushEvent(world, { type: 'news', text: '電化の工事ができるようになりました（鉄道建設の「電化」で、線路をなぞって架線を張れます）', tone: 'good' });
  const fresh = ([...ENGINE_TYPES, ...WAGON_TYPES] as VehicleType[]).filter((t) => vehicleYear(t) === y);
  if (fresh.length) {
    pushEvent(world, {
      type: 'news',
      text: `新型車両が登場しました：${fresh.map((t) => vehicleName(t)).join('・')}（車庫で買えます）`,
      tone: 'good',
    });
  }
  world.finance.lastYear = world.finance.thisYear;
  world.finance.thisYear = emptyFinance();
  for (const t of world.trains.values()) {
    t.profitLastYear = t.profitThisYear;
    t.profitThisYear = 0;
  }
  salesYearly(world);
}

// ───────────────────────── 時間を進める ─────────────────────────

export function step(world: World, ticks: number) {
  const dt = 1 / TICKS_PER_DAY;
  for (let k = 0; k < ticks; k++) {
    world.tick++;
    for (const t of world.trains.values()) trainTick(world, t, dt);
    if (world.tick % TICKS_PER_DAY === 0) {
      const prev = dateOf(world.day);
      world.day++;
      const cur = dateOf(world.day);
      daily(world);
      if (cur.m !== prev.m) monthly(world);
      if (cur.y !== prev.y) yearly(world);
    }
  }
}

/** 統計だけ計算し直す（ロード直後やマップ生成直後に使う） */
export function refreshStats(world: World) {
  const hb = housesByTown(world);
  for (const town of world.towns.values()) recountTown(world, town, hb.get(town.id) ?? []);
}

export function stationAccepts(world: World, st: Station): Cargo[] {
  const a = acceptance(world, st);
  return CARGOS.filter((c) => (a.by[c]?.length ?? 0) > 0);
}
