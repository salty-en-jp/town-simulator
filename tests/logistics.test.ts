import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, startStop } from '../src/sim/commands';
import { TICKS_PER_DAY, TOWN } from '../src/sim/constants';
import { addIndustry, addTown } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { acceptors, step } from '../src/sim/simulate';
import { createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

describe('2つの材料がいる工場', () => {
  it('製鉄所は鉄鉱石と石炭の両方がそろわないと動かない', () => {
    const w = createEmptyWorld(20, 20, 1);
    const mill = addIndustry(w, 'steelmill', '製鉄所', 5, 5, 3, 3);
    mill.inputs.ore = 100;
    days(w, 10);
    expect(mill.producedThisMonth + mill.producedLastMonth).toBe(0);
    expect(mill.inputs.ore).toBe(100);
    mill.inputs.coal = 30;
    days(w, 10);
    expect(mill.outStock).toBeCloseTo(30, 0);
    expect(mill.inputs.coal).toBeCloseTo(0, 5);
    expect(mill.inputs.ore).toBeCloseTo(70, 0);
  });
});

/** 駅の集客範囲に製材所が2つある世界 */
function twoSawmills() {
  const w = createEmptyWorld(48, 16, 4);
  w.money = 500_000_000;
  const forest = addIndustry(w, 'forest', '森', 2, 2, 3, 3);
  const near = addIndustry(w, 'sawmill', '近い製材所', 30, 3, 3, 2);
  const far = addIndustry(w, 'sawmill', '遠い製材所', 36, 11, 3, 2);
  buildTrack(w, idx(w, 1, 7), idx(w, 40, 7));
  const s1 = buildStation(w, idx(w, 3, 7), idx(w, 5, 7)).id!;
  const s2 = buildStation(w, idx(w, 32, 7), idx(w, 34, 7)).id!;
  const depot = buildDepot(w, idx(w, 8, 8)).id!;
  return { w, forest, near, far, s1, s2, depot };
}

describe('届け先', () => {
  it('集客範囲の受け入れ先は近い順に並ぶ', () => {
    const { w, near, far, s2 } = twoSawmills();
    const list = acceptors(w, w.stations.get(s2)!, 'logs');
    expect(list.map((a) => a.id)).toEqual([near.id, far.id]);
  });

  it('指令で選ばなければ近い方、選べばその工場に届く', () => {
    const { w, near, far, s1, s2, depot } = twoSawmills();
    const a = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    addOrder(w, a, s1, 'full_any');
    addOrder(w, a, s2);
    startStop(w, a);
    days(w, 80);
    expect(near.receivedTotal).toBeGreaterThan(0);
    expect(far.receivedTotal).toBe(0);
    // 届け先を遠い方に
    const ol = w.orderLists.get(w.trains.get(a)!.orderList)!;
    ol.orders[1].dest = { kind: 'industry', id: far.id };
    const before = near.receivedTotal;
    days(w, 80);
    expect(far.receivedTotal).toBeGreaterThan(0);
    expect(near.receivedTotal).toBe(before);
  });
});

describe('町と食料品・建設資材', () => {
  function town() {
    const w = createEmptyWorld(30, 30, 2);
    const t = addTown(w, '町', 15, 15);
    let n = 0;
    for (let y = 11; y <= 19; y++)
      for (let x = 11; x <= 19; x++) {
        if ((x + y) % 2 === 0 && n < 20) {
          w.occ[idx(w, x, y)] = { k: 'house', town: t.id, level: 2, variant: 0 };
          n++;
        }
      }
    return { w, t };
  }

  it('食料品があると「足りている」になり、毎日減る', () => {
    const { w, t } = town();
    t.stock.food = 50;
    days(w, 2);
    expect(t.fed).toBe(true);
    expect(t.stock.food!).toBeLessThan(50);
    t.stock.food = 0;
    days(w, 1);
    expect(t.fed).toBe(false);
  });

  it('建設資材が届くと高層ビルに建て替わる', () => {
    const { w, t } = town();
    t.stock.materials = TOWN.materialsPerUpgrade3 * 3;
    days(w, 5);
    const towers = w.occ.filter((o) => o?.k === 'house' && o.level === 3).length;
    expect(towers).toBeGreaterThan(0);
    expect(t.stock.materials!).toBeLessThan(TOWN.materialsPerUpgrade3 * 3);
  });
});

describe('古いセーブ', () => {
  it('試作版の古いセーブは、わかりやすいエラーで断る', () => {
    const w = createEmptyWorld(20, 20, 3);
    const file = JSON.parse(serializeWorld(w));
    file.version = 2;
    expect(() => deserializeWorld(JSON.stringify(file))).toThrow(/古いセーブ/);
  });
});
