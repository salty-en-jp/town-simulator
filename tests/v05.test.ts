import { describe, expect, it } from 'vitest';
import {
  addOrder,
  buildDepot,
  buildStation,
  buildTrack,
  buyTrain,
  cloneTrain,
  demolish,
  replaceStationInOrders,
  setOrderSplit,
  startStop,
  stationTrains,
} from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { addIndustry, industryStatus } from '../src/sim/industries';
import { addTown } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { step, vehicleAssets } from '../src/sim/simulate';
import { createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

function line() {
  const w = createEmptyWorld(48, 16, 3);
  w.money = 1e9;
  w.requestState.nextCheckDay = 1e9;
  buildTrack(w, idx(w, 1, 7), idx(w, 44, 7));
  const a = buildStation(w, idx(w, 2, 7), idx(w, 3, 7)).id!;
  const b = buildStation(w, idx(w, 20, 7), idx(w, 21, 7)).id!;
  const c = buildStation(w, idx(w, 40, 7), idx(w, 41, 7)).id!;
  const depot = buildDepot(w, idx(w, 10, 8)).id!;
  return { w, a, b, c, depot };
}

describe('駅に止まる列車と差し替え', () => {
  it('駅に止まる列車を、指令の共有ごとにまとめて出す', () => {
    const { w, a, b, c, depot } = line();
    const t1 = buyTrain(w, depot, ['coach']).id!;
    addOrder(w, t1, a);
    addOrder(w, t1, b);
    cloneTrain(w, t1, depot, true);
    const t3 = buyTrain(w, depot, ['coach']).id!;
    addOrder(w, t3, b);
    addOrder(w, t3, c);
    const groups = stationTrains(w, b);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.trains.length).sort()).toEqual([1, 2]);
    expect(stationTrains(w, a).length).toBe(1);
  });

  it('差し替えると駅を解体できるようになり、続いた同じ駅はまとまる', () => {
    const { w, a, b, c, depot } = line();
    const t1 = buyTrain(w, depot, ['coach']).id!;
    addOrder(w, t1, a);
    addOrder(w, t1, b);
    addOrder(w, t1, c);
    const st = w.stations.get(b)!;
    expect(demolish(w, st.tiles[0], st.tiles[1]).ok).toBe(false);
    const r = replaceStationInOrders(w, b, c);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    const orders = w.orderLists.get(w.trains.get(t1)!.orderList)!.orders;
    expect(orders.map((o) => o.station)).toEqual([a, c]);
    expect(demolish(w, st.tiles[0], st.tiles[1]).ok).toBe(true);
  });

  it('列車を選んで差し替えると、ほかの列車の指令はそのまま', () => {
    const { w, a, b, c, depot } = line();
    const t1 = buyTrain(w, depot, ['coach']).id!;
    addOrder(w, t1, a);
    addOrder(w, t1, b);
    const t2 = buyTrain(w, depot, ['coach']).id!;
    addOrder(w, t2, a);
    addOrder(w, t2, b);
    replaceStationInOrders(w, b, c, [w.trains.get(t1)!.orderList]);
    expect(w.orderLists.get(w.trains.get(t1)!.orderList)!.orders[1].station).toBe(c);
    expect(w.orderLists.get(w.trains.get(t2)!.orderList)!.orders[1].station).toBe(b);
  });
});

describe('振り分け', () => {
  it('1両の荷を、割合どおりに2か所へ降ろす', () => {
    const w = createEmptyWorld(48, 20, 5);
    w.money = 1e9;
    w.requestState.nextCheckDay = 1e9;
    const forest = addIndustry(w, 'forest', '森', 2, 2, 3, 3);
    forest.outStock = 400;
    const s1 = addIndustry(w, 'sawmill', '製材所A', 30, 3, 3, 2);
    const s2 = addIndustry(w, 'sawmill', '製材所B', 36, 11, 3, 2);
    buildTrack(w, idx(w, 1, 7), idx(w, 40, 7));
    const a = buildStation(w, idx(w, 3, 7), idx(w, 5, 7)).id!;
    const b = buildStation(w, idx(w, 32, 7), idx(w, 34, 7)).id!;
    const depot = buildDepot(w, idx(w, 8, 8)).id!;
    const tr = buyTrain(w, depot, ['logcar']).id!;
    addOrder(w, tr, a, 'full_any');
    addOrder(w, tr, b);
    expect(setOrderSplit(w, tr, 1, [
      { kind: 'industry', id: s1.id, w: 1 },
      { kind: 'industry', id: s2.id, w: 1 },
    ]).ok).toBe(true);
    startStop(w, tr);
    days(w, 90);
    expect(s1.receivedTotal).toBeGreaterThan(0);
    expect(s2.receivedTotal).toBeGreaterThan(0);
    const ratio = s1.receivedTotal / (s1.receivedTotal + s2.receivedTotal);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

describe('毎月の記録', () => {
  it('列車・産業・会社の記録が毎月たまり、セーブにも残る', () => {
    const { w, a, c, depot } = line();
    addTown(w, '町A', 3, 11);
    addTown(w, '町C', 41, 11);
    for (const [x, y] of [[2, 10], [4, 10], [3, 12], [40, 10], [42, 10], [41, 12]]) w.occ[idx(w, x, y)] = { k: 'house', town: [...w.towns.keys()][x < 20 ? 0 : 1], level: 2, variant: 0 };
    const ind = addIndustry(w, 'forest', '森', 20, 2, 3, 3);
    const t1 = buyTrain(w, depot, ['coach', 'coach']).id!;
    addOrder(w, t1, a);
    addOrder(w, t1, c);
    startStop(w, t1);
    days(w, 100);
    const t = w.trains.get(t1)!;
    expect(t.hist.length).toBeGreaterThanOrEqual(3);
    expect(ind.hist.p.length).toBe(t.hist.length);
    expect(w.history.money.length).toBe(w.monthIndex);
    expect(w.history.assets.at(-1)!).toBeGreaterThan(0);
    expect(w.history.assets.at(-1)!).toBeLessThanOrEqual(vehicleAssets(w) + 1_000_000);
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.trains.get(t1)!.hist).toEqual(t.hist);
    expect(w2.history.income).toEqual(w.history.income);
  });
});

describe('産業の稼働状況', () => {
  it('材料なし・片方だけ・運び出されていない・順調・置き場いっぱい・他社を見分ける', () => {
    const w = createEmptyWorld(40, 40, 2);
    const mill = addIndustry(w, 'steelmill', '製鉄所', 5, 5, 3, 3);
    expect(industryStatus(w, mill).code).toBe('idle');
    mill.inputs.ore = 50;
    expect(industryStatus(w, mill).code).toBe('lacking');
    const forest = addIndustry(w, 'forest', '森', 20, 20, 3, 3);
    forest.producedLastMonth = 70;
    expect(industryStatus(w, forest).code).toBe('unserved');
    forest.transportedLastMonth = 60;
    expect(industryStatus(w, forest).code).toBe('ok');
    forest.outStock = 499;
    expect(industryStatus(w, forest).code).toBe('full');
    const other = addIndustry(w, 'coalmine', '炭鉱', 30, 5, 2, 2, 'other');
    expect(industryStatus(w, other).code).toBe('locked');
  });
});
