import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, startStop } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { addTown } from '../src/sim/mapgen';
import { step } from '../src/sim/simulate';
import { INTERCITY, intercityMul, townNear } from '../src/sim/towns';
import { createEmptyWorld, idx, type Town } from '../src/sim/world';

const fake = (id: number, population: number) => ({ id, population }) as Town;

describe('都市間の旅客', () => {
  it('大きな町どうしほど運賃が上がる。同じ町の中は上がらない', () => {
    expect(intercityMul(fake(1, 10000), fake(2, 10000))).toBeCloseTo(2.5);
    expect(intercityMul(fake(1, 5000), fake(2, 5000))).toBeCloseTo(1.75);
    expect(intercityMul(fake(1, 5000), fake(2, 200))).toBeLessThan(1.2);
    expect(intercityMul(fake(1, 9000), fake(1, 9000))).toBe(1);
    expect(intercityMul(null, fake(2, 9000))).toBe(1);
  });

  it('乗った駅のそばの町がわかる（遠すぎると町の旅客ではない）', () => {
    const w = createEmptyWorld(80, 20, 3);
    const a = addTown(w, 'A', 10, 10);
    addTown(w, 'B', 70, 10);
    expect(townNear(w, idx(w, 14, 10))?.id).toBe(a.id);
    expect(townNear(w, idx(w, 40, 10))).toBeNull();
  });

  it('大きな町どうしを結ぶと、旅客1人あたりの収入が増える', () => {
    const run = (bonus: number) => {
      const keep = INTERCITY.maxBonus;
      INTERCITY.maxBonus = bonus;
      const level = 3;
      const w = createEmptyWorld(70, 24, 3);
      w.money = 1e10;
      w.requestState.nextCheckDay = 1e9;
      w.towns.clear();
      const towns = [addTown(w, 'A', 10, 12), addTown(w, 'B', 58, 12)];
      for (const t of towns)
        for (let dx = -4; dx <= 4; dx++) for (const dy of [-3, -2, 2, 3]) w.occ[idx(w, t.cx + dx, t.cy + dy)] = { k: 'house', town: t.id, level, variant: 0 };
      buildTrack(w, idx(w, 3, 12), idx(w, 66, 12));
      const sa = buildStation(w, idx(w, 9, 12), idx(w, 10, 12)).id!;
      const sb = buildStation(w, idx(w, 57, 12), idx(w, 58, 12)).id!;
      const depot = buildDepot(w, idx(w, 30, 13)).id!;
      const tr = buyTrain(w, depot, ['coach', 'coach', 'coach']).id!;
      addOrder(w, tr, sa);
      addOrder(w, tr, sb);
      startStop(w, tr);
      const before = w.finance.thisYear.income;
      step(w, 200 * TICKS_PER_DAY);
      INTERCITY.maxBonus = keep;
      const pax = towns.reduce((n, t) => n + (t.recv.passengers?.total ?? 0), 0);
      const pop = towns.map((t) => t.population);
      return { perPax: (w.finance.thisYear.income + w.finance.lastYear.income - before) / pax, pop };
    };
    const off = run(0);
    const on = run(INTERCITY.maxBonus);
    // 2つの町の人口からの見込みどおりに増える
    const expected = intercityMul({ id: 1, population: on.pop[0] } as never, { id: 2, population: on.pop[1] } as never);
    expect(expected).toBeGreaterThan(1.3);
    expect(on.perPax / off.perPax).toBeGreaterThan(expected * 0.9);
    expect(on.perPax / off.perPax).toBeLessThan(expected * 1.1);
  });
});
