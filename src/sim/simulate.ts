// 時間を進める：列車の移動・積み降ろし、毎日の生産と町の成長、毎月のお金

import {
  CARGOS,
  ENGINE,
  HOUSE_PAX_PER_DAY,
  HOUSE_POP,
  INDUSTRY,
  STATION,
  TICKS_PER_DAY,
  TOWN,
  type Cargo,
} from './constants';
import { cargoIncome, demandFactor } from './economy';
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
  idx,
  inBounds,
  manhattan,
  pushEvent,
  rectContains,
  rectOverlapsIndustry,
  spend,
  stationCatchment,
  stationSign,
  Terrain,
  trainSpeed,
  tx,
  ty,
  type Industry,
  type Rect,
  type Station,
  type Town,
  type Train,
  type World,
} from './world';

// ───────────────────────── 受け入れ判定（キャッシュ付き） ─────────────────────────

export interface Acceptance {
  passengers: boolean;
  logs: boolean;
  lumber: boolean;
  /** 原木を届ける製材所 */
  sawmill: number;
  /** 旅客・木材を届ける町 */
  town: number;
  houses: number;
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
  const r = stationCatchment(world, st);
  const sign = stationSign(st);
  let houses = 0;
  let town = -1;
  let townDist = Infinity;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const o = world.occ[idx(world, x, y)];
      if (o?.k !== 'house') continue;
      houses++;
      const d = Math.abs(x - tx(world, sign)) + Math.abs(y - ty(world, sign));
      if (d < townDist) {
        townDist = d;
        town = o.town;
      }
    }
  }
  let sawmill = -1;
  let sawDist = Infinity;
  for (const ind of world.industries.values()) {
    if (ind.type !== 'sawmill' || !rectOverlapsIndustry(r, ind)) continue;
    const d = Math.abs(ind.x + 1 - tx(world, sign)) + Math.abs(ind.y + 1 - ty(world, sign));
    if (d < sawDist) {
      sawDist = d;
      sawmill = ind.id;
    }
  }
  const acc: Acceptance = {
    passengers: houses >= 2,
    lumber: houses >= 1,
    logs: sawmill >= 0,
    sawmill,
    town,
    houses,
  };
  c.map.set(st.id, acc);
  return acc;
}

// ───────────────────────── 列車 ─────────────────────────

function goalsFor(world: World, t: Train): Set<number> | null {
  if (t.heading === 'depot') {
    const d = world.depots.get(t.depotId);
    return d ? new Set([d.tile]) : null;
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
      const p = goals.has(next) ? [next] : findPath(world, next, goals);
      if (p) {
        t.path = [here, ...p];
        t.state = 'running';
        return;
      }
    }
  }
  t.progress = 0;
  const p = findPath(world, here, goals);
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
    const d = world.depots.get(t.depotId);
    if (d && d.tile === tile) {
      t.state = 'in_depot';
      t.heading = 'order';
      t.trail = [];
      t.trackVersion = -1;
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

function deliver(world: World, t: Train, st: Station, cargo: Cargo, maxAmount: number): number {
  const acc = acceptance(world, st);
  if (!acc[cargo]) return 0;
  let limit = maxAmount;
  let demand = 1;
  let sawmill: Industry | undefined;
  let town: Town | undefined;
  if (cargo === 'logs') {
    sawmill = world.industries.get(acc.sawmill);
    if (!sawmill) return 0;
    limit = Math.min(limit, INDUSTRY.stockCap - sawmill.inStock);
    demand = demandFactor(sawmill.inStock);
    if (limit <= 0.001) return 0;
  } else {
    town = world.towns.get(acc.town);
  }
  let delivered = 0;
  const sign = stationSign(st);
  for (const car of t.cars) {
    if (carCargo(car) !== cargo) continue;
    for (const p of car.packets) {
      if (p.from === st.id || p.amount <= 0) continue;
      const take = Math.min(p.amount, limit - delivered);
      if (take <= 0) break;
      p.amount -= take;
      delivered += take;
      const income = cargoIncome(cargo, take, manhattan(world, p.fromTile, sign), p.days, demand);
      earn(world, 'income', income);
      t.incomeThisStop += income;
      t.profitThisYear += income;
    }
    car.packets = car.packets.filter((p) => p.amount > 0.0001);
    if (delivered >= limit) break;
  }
  if (delivered > 0) {
    if (sawmill) {
      sawmill.inStock += delivered;
      sawmill.receivedThisMonth += delivered;
    } else if (town) {
      if (cargo === 'lumber') {
        town.lumber += delivered;
        town.lumberReceivedThisMonth += delivered;
      } else town.paxReceivedThisMonth += delivered;
    }
  }
  return delivered;
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
      if (deliver(world, t, st, cargo, perCar * nCars) > 0) busy = true;
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
  for (const car of t.cars) for (const p of car.packets) p.days += dt;
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
    const perDay = ind.prodRate / 30;
    if (ind.type === 'forest') {
      const p = Math.max(0, Math.min(perDay, INDUSTRY.stockCap - ind.outStock));
      ind.outStock += p;
      ind.producedThisMonth += p;
    } else {
      const conv = Math.max(0, Math.min(ind.inStock, perDay, INDUSTRY.stockCap - ind.outStock));
      ind.inStock -= conv;
      ind.outStock += conv;
      ind.producedThisMonth += conv;
    }
    const cargo: Cargo = ind.type === 'forest' ? 'logs' : 'lumber';
    const cands = bestStations(world, ctx, cargo, (r) => rectOverlapsIndustry(r, ind));
    const moved = handToStations(cands, cargo, ind.outStock);
    ind.outStock -= moved;
    ind.transportedThisMonth += moved;
  }
}

function housesDaily(world: World, ctx: DayContext) {
  for (const tiles of ctx.housesByTown.values()) {
    for (const t of tiles) {
      const o = world.occ[t];
      if (o?.k !== 'house') continue;
      const x = tx(world, t),
        y = ty(world, t);
      const cands = bestStations(world, ctx, 'passengers', (r) => rectContains(r, x, y));
      handToStations(cands, 'passengers', HOUSE_PAX_PER_DAY[o.level]);
    }
  }
}

function townCatchesStation(world: World, town: Town, houses: number[], r: Rect): boolean {
  if (rectContains(r, town.cx, town.cy)) return true;
  return houses.some((t) => rectContains(r, tx(world, t), ty(world, t)));
}

function buildableForHouse(world: World, t: number): boolean {
  return world.occ[t] === null && world.track[t] === 0 && world.terrain[t] !== Terrain.Water;
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

function upgradeHouse(world: World, town: Town, houses: number[], to: 2 | 3): boolean {
  const from = to - 1;
  const cands = houses.filter((t) => {
    const o = world.occ[t];
    return o?.k === 'house' && o.level === from;
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

    // 木材が届いていれば家を建てる・建て替える
    if (town.lumber >= TOWN.lumberPerHouse) {
      const pop = town.population;
      if (pop > 300 && town.lumber >= TOWN.lumberPerUpgrade3 && world.rng.chance(0.3) && upgradeHouse(world, town, houses, 3)) {
        town.lumber -= TOWN.lumberPerUpgrade3;
      } else if (world.rng.chance(0.5) && upgradeHouse(world, town, houses, 2)) {
        town.lumber -= TOWN.lumberPerUpgrade2;
      } else {
        const t = growHouse(world, town, houses, stationRects);
        if (t >= 0) {
          houses.push(t);
          town.lumber -= TOWN.lumberPerHouse;
        }
      }
    }

    // ふだんの成長（使われている駅が多いほど速い）
    town.growthTimer -= 1;
    if (town.growthTimer <= 0) {
      town.growthTimer = active === 0 ? 60 : active === 1 ? 20 : active === 2 ? 14 : 9;
      if (active > 0 || world.rng.chance(1 / 3)) {
        const t = growHouse(world, town, houses, stationRects);
        if (t >= 0) houses.push(t);
      }
    }

    recountTown(world, town, houses);
    for (const m of POP_MILESTONES) {
      if (before < m && town.population >= m) {
        pushEvent(world, {
          type: 'news',
          text: `${town.name}町の人口が${m.toLocaleString('ja-JP')}人を超えました！`,
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
  stationsDaily(world);
}

// ───────────────────────── 毎月・毎年 ─────────────────────────

function monthly(world: World) {
  let running = 0;
  for (const t of world.trains.values()) if (t.state !== 'in_depot') running += ENGINE.runningCostPerYear / 12;
  if (running > 0) spend(world, 'running', Math.round(running));
  const interest = Math.round((world.loan * world.interestRate) / 100 / 12);
  if (interest > 0) spend(world, 'interest', interest);

  for (const ind of world.industries.values()) {
    ind.producedLastMonth = ind.producedThisMonth;
    ind.transportedLastMonth = ind.transportedThisMonth;
    ind.receivedLastMonth = ind.receivedThisMonth;
    ind.producedThisMonth = ind.transportedThisMonth = ind.receivedThisMonth = 0;
    if (ind.type === 'forest') changeProduction(world, ind);
  }
  for (const town of world.towns.values()) {
    town.lumberReceivedLastMonth = town.lumberReceivedThisMonth;
    town.paxReceivedLastMonth = town.paxReceivedThisMonth;
    town.lumberReceivedThisMonth = town.paxReceivedThisMonth = 0;
  }
}

/** 輸送率（運び出された割合）が高いほど生産が増えやすい */
function changeProduction(world: World, ind: Industry) {
  if (!world.rng.chance(1 / 8)) return;
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
  world.finance.lastYear = world.finance.thisYear;
  world.finance.thisYear = emptyFinance();
  for (const t of world.trains.values()) {
    t.profitLastYear = t.profitThisYear;
    t.profitThisYear = 0;
  }
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
  return CARGOS.filter((c) => a[c]);
}
