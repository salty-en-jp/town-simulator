import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { addIndustry, buyRights, expandIndustry, signContract } from '../src/sim/industries';
import { generateWorld } from '../src/sim/mapgen';
import { ensureAirport, ensurePort, hasSea } from '../src/sim/partners';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { acceptorDemand, step } from '../src/sim/simulate';
import { townAccepts } from '../src/sim/towns';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld } from '../src/sim/world';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);
const find = (w: ReturnType<typeof createEmptyWorld>, t: string) => [...w.industries.values()].find((i) => i.type === t);

describe('港', () => {
  it('海のあるマップには港と化学工場がある。山がち・平野にはない', () => {
    const coast = generateWorld(7, 96, 'coast');
    expect(hasSea(coast)).toBe(true);
    expect(find(coast, 'port')).toBeDefined();
    expect(find(coast, 'chemplant')).toBeDefined();
    const mountains = generateWorld(7, 96, 'mountains');
    expect(find(mountains, 'port')).toBeUndefined();
  });

  it('輸出は海外の相場で買い取り、受け入れた貨物は残らない。石油を出す', () => {
    const w = generateWorld(7, 96, 'coast');
    const port = find(w, 'port')!;
    w.foreignMarket = 1.4;
    const high = acceptorDemand(w, { kind: 'industry', id: port.id }, 'logs');
    w.foreignMarket = 0.8;
    expect(acceptorDemand(w, { kind: 'industry', id: port.id }, 'logs')).toBeLessThan(high);
    port.inputs.logs = 200;
    step(w, TICKS_PER_DAY * 3);
    expect(port.inputs.logs).toBe(0);
    expect(port.producedThisMonth + port.producedLastMonth).toBeGreaterThan(0);
  });

  it('港・空港は取引先：権利の購入・契約・増産はできない', () => {
    const w = generateWorld(7, 96, 'coast');
    w.money = 1e10;
    const port = find(w, 'port')!;
    expect(buyRights(w, port.id).ok).toBe(false);
    expect(signContract(w, port.id).ok).toBe(false);
    expect(expandIndustry(w, port.id).ok).toBe(false);
  });

  it('前の版のセーブ（港のない海のマップ）には、毎月たしかめて港を置く', () => {
    const w = generateWorld(7, 96, 'coast');
    for (const i of [...w.industries.values()]) if (i.type === 'port' || i.type === 'chemplant') w.industries.delete(i.id);
    for (let t = 0; t < w.occ.length; t++) if (w.occ[t]?.k === 'industry' && !w.industries.has((w.occ[t] as { id: number }).id)) w.occ[t] = null;
    ensurePort(w, true);
    expect(find(w, 'port')).toBeDefined();
    expect(find(w, 'chemplant')).toBeDefined();
  });
});

describe('石油と日用品', () => {
  it('化学工場は石油から日用品をつくる。日用品は町（1,000人〜）が受け入れ、村は受け入れない', () => {
    const w = createEmptyWorld(30, 30, 3);
    const c = addIndustry(w, 'chemplant', '化学工場', 5, 5, 3, 2);
    c.inputs.oil = 100;
    step(w, TICKS_PER_DAY * 5);
    expect(c.producedThisMonth).toBeGreaterThan(0);
    const g = generateWorld(9);
    const towns = [...g.towns.values()];
    const village = towns.find((t) => t.population < 1000);
    if (village) expect(townAccepts(g, village.id, 'goods')).toBe(false);
    const big = towns.sort((a, b) => b.population - a.population)[0];
    big.population = 1500;
    big.stage = 1;
    expect(townAccepts(g, big.id, 'goods')).toBe(true);
  });
});

describe('空港', () => {
  it('1970年から、都市（5,000人）のそばにできる。旅客を高い運賃で受け入れる', () => {
    const w = generateWorld(11);
    w.day = dayOfYear(1969);
    const town = [...w.towns.values()][0];
    town.population = 6000;
    town.stage = 2;
    ensureAirport(w);
    expect(find(w, 'airport')).toBeUndefined();
    w.day = dayOfYear(1970);
    ensureAirport(w);
    const ap = find(w, 'airport');
    expect(ap).toBeDefined();
    expect(ap!.name).toContain('空港');
    expect(acceptorDemand(w, { kind: 'industry', id: ap!.id }, 'passengers')).toBeGreaterThan(1.5);
    expect(buyRights(w, ap!.id).ok).toBe(false);
    // セーブして読み込める
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const w2 = deserializeWorld(serializeWorld(w));
    expect(find(w2, 'airport')).toBeDefined();
  });
});
