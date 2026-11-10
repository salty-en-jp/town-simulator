import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { generateWorld, MAP_SIZES } from '../src/sim/mapgen';
import { marketMonthly } from '../src/sim/market';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { paceMul } from '../src/sim/world';

describe('マップの広さ', () => {
  it('広さで町と産業の数が決まる', () => {
    const counts = Object.values(MAP_SIZES).map((m) => {
      const w = generateWorld(77, m.size);
      return { towns: w.towns.size, inds: w.industries.size, w: w.w };
    });
    expect(counts.map((c) => c.towns)).toEqual([3, 4, 6]);
    expect(counts[0].inds).toBeLessThan(counts[1].inds);
    expect(counts[2].inds).toBeGreaterThan(counts[1].inds);
    expect(counts.map((c) => c.w)).toEqual([64, 96, 128]);
  });

  it('どの広さでも、しばらく動かして壊れない', () => {
    for (const m of Object.values(MAP_SIZES)) {
      const w = generateWorld(5, m.size);
      w.requestState.nextCheckDay = 1e9;
      step(w, 90 * TICKS_PER_DAY);
      expect([...w.towns.values()].every((t) => t.population > 0)).toBe(true);
      expect(() => deserializeWorld(serializeWorld(w))).not.toThrow();
    }
  });
});

describe('時間の流れ', () => {
  it('目まぐるしいほど相場がよく動き、ブームがよく来る', () => {
    const run = (pace: 'slow' | 'fast') => {
      const w = generateWorld(9);
      w.pace = pace;
      let moves = 0,
        booms = 0;
      for (let m = 0; m < 240; m++) {
        const before = { ...w.market };
        const n = w.booms?.length ?? 0;
        marketMonthly(w);
        for (const [k, v] of Object.entries(w.market!)) moves += Math.abs(v! - (before[k as keyof typeof before] ?? 1));
        booms += Math.max(0, (w.booms?.length ?? 0) - n);
        w.day += 30;
      }
      return { moves, booms };
    };
    const slow = run('slow');
    const fast = run('fast');
    expect(fast.moves).toBeGreaterThan(slow.moves);
    expect(fast.booms).toBeGreaterThan(slow.booms);
  });

  it('時間の流れはセーブに残り、前の版のセーブは「ふつう」', () => {
    const w = generateWorld(10);
    w.pace = 'fast';
    expect(paceMul(w)).toBeGreaterThan(1);
    expect(deserializeWorld(serializeWorld(w)).pace).toBe('fast');
    const f = JSON.parse(serializeWorld(w));
    delete f.world.pace;
    expect(deserializeWorld(JSON.stringify(f)).pace).toBe('normal');
  });
});
