import { describe, expect, it } from 'vitest';
import { buildStation, buildTrack } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { canPlaceIndustry } from '../src/sim/industries';
import { addIndustry, generateWorld, LANDFORMS, type Landform } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { growHouse, step } from '../src/sim/simulate';
import { createEmptyWorld, idx, Terrain } from '../src/sim/world';

const count = (t: Uint8Array, v: number) => t.reduce((n, x) => n + (x === v ? 1 : 0), 0);

describe('地形', () => {
  it('山がちは岩場が多く、海沿いは海が広い。どの地形にも牧場、海があれば漁港', () => {
    const r: Record<string, { rock: number; water: number; types: Set<string> }> = {};
    for (const k of Object.keys(LANDFORMS) as Landform[]) {
      const w = generateWorld(31, 96, k);
      r[k] = { rock: count(w.terrain, Terrain.Rock), water: count(w.terrain, Terrain.Water), types: new Set([...w.industries.values()].map((i) => i.type)) };
      expect(r[k].types.has('ranch')).toBe(true);
      expect(w.towns.size).toBe(4);
      expect(w.landform).toBe(k);
    }
    expect(r.mountains.rock).toBeGreaterThan(r.mixed.rock);
    expect(r.mixed.rock).toBeGreaterThan(r.plains.rock);
    expect(r.coast.water).toBeGreaterThan(r.mixed.water * 1.5);
    expect(r.coast.types.has('fishery')).toBe(true);
    expect(r.plains.types.has('fishery')).toBe(false);
  });

  it('町は海の上にできない。岩場には家が建たない', () => {
    const w = generateWorld(32, 96, 'coast');
    for (const t of w.towns.values()) expect(w.terrain[idx(w, t.cx, t.cy)]).not.toBe(Terrain.Water);
    const e = createEmptyWorld(20, 20, 1);
    for (let i = 0; i < e.terrain.length; i++) e.terrain[i] = Terrain.Rock;
    e.terrain[idx(e, 10, 10)] = Terrain.Grass;
    const town = { id: 1, name: 'a', cx: 10, cy: 10, stock: {}, recv: {}, growthTimer: 0, fed: false, population: 0, houses: 0, activeStations: 0 };
    e.towns.set(1, town);
    const t1 = growHouse(e, town, [], []);
    expect(t1).toBe(idx(e, 10, 10));
    expect(growHouse(e, town, [t1], [])).toBe(-1);
  });

  it('岩場の線路は高くつく', () => {
    const a = createEmptyWorld(30, 10, 1);
    const b = createEmptyWorld(30, 10, 1);
    for (let x = 0; x < 30; x++) b.terrain[idx(b, x, 5)] = Terrain.Rock;
    const ca = buildTrack(a, idx(a, 2, 5), idx(a, 20, 5), { dry: true } as never).cost!;
    const cb = buildTrack(b, idx(b, 2, 5), idx(b, 20, 5), { dry: true } as never).cost!;
    expect(cb).toBeGreaterThan(ca * 2);
  });

  it('漁港は広い水辺のそばにしか置けない', () => {
    const w = createEmptyWorld(30, 30, 1);
    expect(canPlaceIndustry(w, 'fishery', 10, 10, false)).toMatch(/水辺/);
    for (let y = 14; y < 30; y++) for (let x = 0; x < 30; x++) w.terrain[idx(w, x, y)] = Terrain.Water;
    expect(canPlaceIndustry(w, 'fishery', 10, 12, false)).toBeNull();
  });
});

describe('食品工場の材料', () => {
  it('魚だけ・家畜だけでも食料品をつくる', () => {
    for (const c of ['fish', 'livestock'] as const) {
      const w = createEmptyWorld(20, 20, 1);
      const f = addIndustry(w, 'foodplant', '工場', 5, 5, 3, 2);
      f.inputs[c] = 100;
      step(w, 5 * TICKS_PER_DAY);
      expect(f.producedThisMonth).toBeGreaterThan(5);
      expect(f.inputs[c]!).toBeLessThan(100);
    }
  });
});

describe('前の版のセーブ', () => {
  it('駅に家畜・魚の欄がなくても読み込めて、そのまま動く', () => {
    const w = generateWorld(33);
    buildTrack(w, idx(w, 5, 5), idx(w, 15, 5));
    buildStation(w, idx(w, 8, 5), idx(w, 9, 5));
    const f = JSON.parse(serializeWorld(w));
    for (const st of f.world.stations) {
      delete st.goods.livestock;
      delete st.goods.fish;
    }
    delete f.world.landform;
    const w2 = deserializeWorld(JSON.stringify(f));
    expect([...w2.stations.values()][0].goods.fish.waiting).toBe(0);
    expect(w2.landform).toBe('mixed');
    expect(() => step(w2, 10 * TICKS_PER_DAY)).not.toThrow();
  });
});
