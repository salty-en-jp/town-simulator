import { describe, expect, it } from 'vitest';
import { buildDepot, buildTrack, buyTrain } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { chooseTest, startDesign, testChance, type Design } from '../src/sim/devel';
import { saleOf, unitProfit } from '../src/sim/sales';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { hasPart, partStatMul, research, researchError, TECH, techMonthly } from '../src/sim/tech';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld, idx } from '../src/sim/world';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function world() {
  const w = createEmptyWorld(30, 16, 3);
  w.money = 1e10;
  w.requestState.nextCheckDay = 1e9;
  w.makerOwned = true;
  return w;
}

describe('技術点と部品', () => {
  it('走っている列車で、毎月技術点がたまる', () => {
    const w = world();
    buildTrack(w, idx(w, 2, 5), idx(w, 27, 5));
    const depot = buildDepot(w, idx(w, 10, 6)).id!;
    const t = buyTrain(w, depot, ['coach']).id!;
    // 車庫の中の列車ではたまらない
    techMonthly(w);
    expect(w.tech ?? 0).toBe(0);
    w.trains.get(t)!.state = 'running';
    techMonthly(w);
    techMonthly(w);
    expect(w.tech).toBeCloseTo(TECH.perTrain * 2);
  });

  it('技術点とお金で部品を研究すると、開発が強くなる。年代・技術点が足りないとできない', () => {
    const w = world();
    expect(researchError(w, 'boiler')).toContain('技術点');
    w.tech = 100;
    expect(researchError(w, 'regen')).toContain('1976');
    const before = testChance(w, 'daring');
    expect(research(w, 'testbed')).toBeNull();
    expect(hasPart(w, 'testbed')).toBe(true);
    expect(testChance(w, 'daring')).toBeGreaterThan(before);
    expect(research(w, 'testbed')).not.toBeNull();
    expect(w.tech).toBe(80);
    research(w, 'boiler');
    expect(partStatMul(w, 'steam', 'might')).toBeGreaterThan(1);
    expect(partStatMul(w, 'diesel', 'might')).toBe(1);
  });

  it('研究所の拡張で開発の日数が短くなる・量産ラインで1両の利益が上がる・完成で技術点が増える', () => {
    const w = world();
    w.day = dayOfYear(1970);
    w.tech = 200;
    const d0 = startDesign(w, { name: 'A', power: 'diesel', use: 'freight', budget: 0 }) as Design;
    const days0 = d0.days;
    for (let i = 0; i < 400 && d0.done === undefined; i++) {
      if (d0.waiting) chooseTest(w, d0.id, 'safe');
      step(w, TICKS_PER_DAY);
    }
    expect(w.tech).toBeGreaterThanOrEqual(200 + TECH.onDesign - 1);
    const p0 = unitProfit(w, d0);
    research(w, 'lab');
    research(w, 'massline');
    expect(unitProfit(w, d0)).toBeGreaterThan(p0);
    const d1 = startDesign(w, { name: 'B', power: 'diesel', use: 'freight', budget: 0 }) as Design;
    expect(d1.days).toBeLessThan(days0);
    expect(saleOf(d0).markup).toBe(1);
  });

  it('セーブして読み込んでも、技術点と部品が残る', () => {
    const w = world();
    w.tech = 50;
    research(w, 'bogie');
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.tech).toBe(35);
    expect(hasPart(w2, 'bogie')).toBe(true);
    const bad = JSON.parse(serializeWorld(w));
    bad.world.parts = ['nope'];
    expect(() => deserializeWorld(JSON.stringify(bad))).toThrow();
  });
});
