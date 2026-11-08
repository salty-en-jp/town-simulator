import { describe, expect, it } from 'vitest';
import { buildStation, buildTrack } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { startFire } from '../src/sim/events';
import { addTown, generateWorld } from '../src/sim/mapgen';
import { activeBooms, boomMul, MARKET, marketMonthly, startBoom } from '../src/sim/market';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { acceptorDemand, step } from '../src/sim/simulate';
import { createEmptyWorld, idx } from '../src/sim/world';

describe('相場', () => {
  it('毎月ゆっくり動き、範囲からはみ出さない', () => {
    const w = generateWorld(8);
    const seen = new Set<number>();
    for (let m = 0; m < 300; m++) {
      marketMonthly(w);
      for (const v of Object.values(w.market!)) {
        expect(v).toBeGreaterThanOrEqual(MARKET.min);
        expect(v).toBeLessThanOrEqual(MARKET.max);
        seen.add(Math.round(v! * 10));
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('相場とブームが買取係数にかかる', () => {
    const w = generateWorld(9);
    const town = [...w.towns.values()][0];
    const a = { kind: 'town' as const, id: town.id };
    const base = acceptorDemand(w, a, 'lumber');
    w.market = { lumber: 1.2 };
    expect(acceptorDemand(w, a, 'lumber')).toBeCloseTo(base * 1.2);
    startBoom(w, 'rush', a, 'lumber', 2, 100);
    expect(acceptorDemand(w, a, 'lumber')).toBeCloseTo(base * 2.4);
    // 期限が過ぎると元に戻る
    w.day += 101;
    expect(boomMul(w, a, 'lumber')).toBe(1);
  });
});

describe('ブーム', () => {
  it('火事のあとは、その町で木材と建設資材が高く売れる', () => {
    const w = createEmptyWorld(30, 30, 3);
    const town = addTown(w, '町', 15, 15);
    for (let y = 12; y <= 18; y++) for (let x = 12; x <= 18; x++) w.occ[idx(w, x, y)] = { k: 'house', town: town.id, level: 1, variant: 0 };
    town.stage = 1; // 町（木材も建設資材も受け入れる）
    startFire(w, town, idx(w, 14, 14));
    const a = { kind: 'town' as const, id: town.id };
    expect(boomMul(w, a, 'lumber')).toBeGreaterThan(1.3);
    expect(boomMul(w, a, 'materials')).toBeGreaterThan(1.3);
    expect(boomMul(w, a, 'food')).toBe(1);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('復興'))).toBe(true);
  });

  it('何年か遊ぶと、いろいろなブームが起きて、同時に起きる数には上限がある', () => {
    const w = generateWorld(10);
    w.requestState.nextCheckDay = 1e9;
    const kinds = new Set<string>();
    for (let m = 0; m < 120; m++) {
      step(w, 30 * TICKS_PER_DAY);
      for (const b of activeBooms(w)) kinds.add(b.kind);
      expect(activeBooms(w).length).toBeLessThanOrEqual(MARKET.maxBooms + 3);
    }
    expect(kinds.has('rush')).toBe(true);
    expect(kinds.has('shortage')).toBe(true);
    expect(kinds.has('tourism')).toBe(true);
  });

  it('観光ブームの町では旅客が増える', () => {
    const make = () => {
      const w = createEmptyWorld(30, 20, 3);
      w.money = 1e9;
      const town = addTown(w, '村', 10, 10);
      for (let x = 7; x <= 13; x++) for (const y of [8, 12]) w.occ[idx(w, x, y)] = { k: 'house', town: town.id, level: 1, variant: 0 };
      buildTrack(w, idx(w, 2, 10), idx(w, 25, 10));
      const st = buildStation(w, idx(w, 9, 10), idx(w, 10, 10)).id!;
      w.stations.get(st)!.goods.passengers.visited = true;
      return { w, town, st };
    };
    const a = make();
    const b = make();
    startBoom(b.w, 'tourism', { kind: 'town', id: b.town.id }, 'passengers', 2, 365);
    step(a.w, 20 * TICKS_PER_DAY);
    step(b.w, 20 * TICKS_PER_DAY);
    expect(b.w.stations.get(b.st)!.goods.passengers.waiting).toBeGreaterThan(a.w.stations.get(a.st)!.goods.passengers.waiting * 1.2);
  });

  it('相場とブームはセーブに残り、前の版のセーブ（相場なし）も読める', () => {
    const w = generateWorld(11);
    w.market = { steel: 1.25 };
    startBoom(w, 'rush', { kind: 'town', id: [...w.towns.values()][0].id }, 'materials', 1.8, 200);
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.market!.steel).toBe(1.25);
    expect(activeBooms(w2).length).toBe(1);
    const f = JSON.parse(serializeWorld(w));
    delete f.world.market;
    delete f.world.booms;
    const w3 = deserializeWorld(JSON.stringify(f));
    expect(activeBooms(w3).length).toBe(0);
  });
});
