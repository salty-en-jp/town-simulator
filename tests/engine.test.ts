import { describe, expect, it } from 'vitest';
import {
  addOrder,
  buildDepot,
  buildStation,
  buildTrack,
  buyTrain,
  buyVehicle,
  cancelEngineSwap,
  cloneTrain,
  replaceEngine,
  scheduleEngineSwap,
  startStop,
} from '../src/sim/commands';
import { ENGINE_SPECS, TICKS_PER_DAY, vehicleCost } from '../src/sim/constants';
import { step } from '../src/sim/simulate';
import { createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

function setup() {
  const w = createEmptyWorld(48, 16, 4);
  w.money = 1e9;
  w.requestState.nextCheckDay = 1e9;
  w.unlocked.add('express');
  buildTrack(w, idx(w, 1, 7), idx(w, 44, 7));
  const a = buildStation(w, idx(w, 2, 7), idx(w, 3, 7)).id!;
  const b = buildStation(w, idx(w, 40, 7), idx(w, 41, 7)).id!;
  const depot = buildDepot(w, idx(w, 10, 8)).id!;
  const t = buyTrain(w, depot, ['coach', 'coach']).id!;
  addOrder(w, t, a);
  addOrder(w, t, b);
  return { w, a, b, depot, t };
}

describe('機関車の交換', () => {
  it('車庫にいる列車は、貨車と指令はそのままで機関車だけ替わる。古い機関車は留置線へ', () => {
    const { w, depot, t } = setup();
    const train = w.trains.get(t)!;
    const wagons = train.cars.slice(1).map((c) => c.id);
    const oldEngine = train.cars[0].id;
    const orders = w.orderLists.get(train.orderList)!.orders.map((o) => o.station);
    const m0 = w.money;
    expect(replaceEngine(w, t, 'express').ok).toBe(true);
    expect(train.cars[0].type).toBe('express');
    expect(train.cars.slice(1).map((c) => c.id)).toEqual(wagons);
    expect(w.orderLists.get(train.orderList)!.orders.map((o) => o.station)).toEqual(orders);
    expect(w.depots.get(depot)!.stored.map((c) => c.id)).toContain(oldEngine);
    expect(w.money).toBe(m0 - vehicleCost('express'));
  });

  it('古い機関車を売ることもできる。留置線に同じ機関車があれば買わずに使う', () => {
    const { w, depot, t } = setup();
    buyVehicle(w, depot, 'express');
    // 機関車を買うと新しい列車になるので、ばらして留置線に置く
    const extra = [...w.trains.values()].find((x) => x.id !== t)!;
    w.trains.delete(extra.id);
    w.depots.get(depot)!.stored.push(extra.cars[0]);
    const m0 = w.money;
    const r = replaceEngine(w, t, 'express', { sellOld: true });
    expect(r.ok).toBe(true);
    expect(w.money).toBeGreaterThan(m0); // 買わずに、古いのを売った分だけ増える
    expect(w.depots.get(depot)!.stored.some((c) => c.type === 'express')).toBe(false);
    expect(w.depots.get(depot)!.stored.some((c) => c.type === 'steam')).toBe(false);
  });

  it('走っている列車をまとめて交換：車庫に入って交換し、そのまま元の指令で走り出す', () => {
    const { w, depot, t } = setup();
    const t2 = cloneTrain(w, t, depot, true).id!;
    startStop(w, t);
    startStop(w, t2);
    days(w, 3);
    const r = scheduleEngineSwap(w, [t, t2], 'express', false);
    expect(r.ok).toBe(true);
    expect(r.later).toBe(2);
    days(w, 30);
    for (const id of [t, t2]) {
      const tr = w.trains.get(id)!;
      expect(tr.cars[0].type).toBe('express');
      expect(tr.engineSwap ?? null).toBe(null);
      expect(tr.state).not.toBe('in_depot');
    }
    expect(w.depots.get(depot)!.stored.filter((c) => c.type === 'steam').length).toBe(2);
    expect(ENGINE_SPECS.express.speed).toBeGreaterThan(ENGINE_SPECS.steam.speed);
  });

  it('交換待ちは取りやめられる', () => {
    const { w, t } = setup();
    startStop(w, t);
    days(w, 2);
    scheduleEngineSwap(w, [t], 'express', false);
    expect(cancelEngineSwap(w, t).ok).toBe(true);
    days(w, 30);
    expect(w.trains.get(t)!.cars[0].type).toBe('steam');
  });

  it('まだ買えない機関車には替えられない', () => {
    const { w, t } = setup();
    w.unlocked.delete('express');
    expect(replaceEngine(w, t, 'express').ok).toBe(false);
  });
});
