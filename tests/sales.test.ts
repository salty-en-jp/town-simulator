import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { chooseTest, startDesign, type Design } from '../src/sim/devel';
import { monthlyDemand, powerEra, saleOf, SALES, salesOnDesignDone, salesYearly, unitProfit } from '../src/sim/sales';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld } from '../src/sim/world';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function world() {
  const w = createEmptyWorld(30, 16, 3);
  w.money = 1e10;
  w.requestState.nextCheckDay = 1e9;
  return w;
}

function develop(w: ReturnType<typeof world>, d: Design) {
  for (let i = 0; i < 2000 && d.done === undefined; i++) {
    if (d.waiting) chooseTest(w, d.id, 'safe');
    step(w, TICKS_PER_DAY);
  }
}

describe('販売', () => {
  it('完成した機関車は毎月注文が来て、利益が入る。止めると売れない', () => {
    const w = world();
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'freight', budget: 1 }) as Design;
    develop(w, d);
    const s = saleOf(d);
    expect(s.on).toBe(true);
    const before = w.finance.thisYear.devel + w.finance.lastYear.devel;
    step(w, TICKS_PER_DAY * 365);
    expect(s.sold).toBeGreaterThan(0);
    expect(s.profit).toBeGreaterThan(0);
    expect(w.finance.thisYear.devel + w.finance.lastYear.devel).toBeGreaterThan(before);
    s.on = false;
    const sold = s.sold;
    step(w, TICKS_PER_DAY * 200);
    expect(s.sold).toBe(sold);
  });

  it('高いほど1両の利益は大きいが、注文は減る。8年たつと売れなくなる', () => {
    const w = world();
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'commuter', budget: 0 }) as Design;
    develop(w, d);
    const s = saleOf(d);
    s.markup = 0;
    const cheap = [monthlyDemand(w, d), unitProfit(d)];
    s.markup = 3;
    const dear = [monthlyDemand(w, d), unitProfit(d)];
    expect(dear[0]).toBeLessThan(cheap[0]);
    expect(dear[1]).toBeGreaterThan(cheap[1]);
    w.day = d.done! + 365 * SALES.years + 1;
    expect(monthlyDemand(w, d)).toBe(0);
  });

  it('時代の流行：蒸気はだんだん売れなくなり、電気は人気が出る', () => {
    expect(powerEra('steam', 1985)).toBeLessThan(powerEra('steam', 1962));
    expect(powerEra('electric', 1985)).toBeGreaterThan(powerEra('electric', 1966));
  });

  it('他社からの注文にかなう機関車を完成させると、まとめて売れる', () => {
    const w = world();
    w.devOrders = [{ id: 999, from: '北辰鉄道', use: 'freight', minRating: 1, deadline: w.day + 2000, units: 5 }];
    const money = w.money;
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'freight', budget: 0 }) as Design;
    develop(w, d);
    expect(w.devOrders.length).toBe(0);
    expect(saleOf(d).sold).toBeGreaterThanOrEqual(5);
    expect(w.money).toBeGreaterThan(money - 15_000_000);
    // 用途がちがえば、かなわない
    w.devOrders = [{ id: 1000, from: '北辰鉄道', use: 'express', minRating: 1, deadline: w.day + 2000, units: 5 }];
    salesOnDesignDone(w, d);
    expect(w.devOrders.length).toBe(1);
  });

  it('毎年、流行の用途が決まり、鉄道車両大賞が選ばれる', () => {
    const w = world();
    w.day = dayOfYear(1963);
    salesYearly(w);
    expect(w.devTrend?.year).toBe(1963);
    expect(w.awards?.length).toBe(1);
    expect(w.awards![0].mine).toBe(false);
  });

  it('セーブして読み込んでも、販売のようすと注文・大賞の記録が残る', () => {
    const w = world();
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'freight', budget: 0 }) as Design;
    develop(w, d);
    step(w, TICKS_PER_DAY * 400);
    w.devOrders = [{ id: 999, from: 'シルフィード社', use: 'tourist', power: 'steam', minRating: 3, deadline: w.day + 2000, units: 5 }];
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.designs![0].sale?.sold).toBe(saleOf(d).sold);
    expect(w2.devOrders![0].from).toBe('シルフィード社');
    expect(w2.awards?.length).toBe(w.awards?.length);
  });
});
