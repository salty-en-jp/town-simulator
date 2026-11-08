import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { generateWorld } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { step } from '../src/sim/simulate';

describe('町の人口の記録', () => {
  it('毎月の人口を記録し、セーブしても残る', () => {
    const w = generateWorld(5);
    step(w, 95 * TICKS_PER_DAY);
    const t = [...w.towns.values()][0];
    expect(t.popHist?.length).toBe(3);
    expect(t.popHist!.at(-1)).toBeGreaterThan(0);
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.towns.get(t.id)!.popHist).toEqual(t.popHist);
  });

  it('記録のない前の版のセーブも読み込めて、そこから記録が始まる', () => {
    const w = generateWorld(6);
    const f = JSON.parse(serializeWorld(w));
    for (const t of f.world.towns) delete t.popHist;
    const w2 = deserializeWorld(JSON.stringify(f));
    step(w2, 40 * TICKS_PER_DAY);
    expect([...w2.towns.values()].every((t) => (t.popHist?.length ?? 0) >= 1)).toBe(true);
  });
});
