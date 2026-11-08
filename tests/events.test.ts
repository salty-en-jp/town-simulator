import { describe, expect, it } from 'vitest';
import { buildStation, buildTrack } from '../src/sim/commands';
import { EVENTS, eventsMonthly, startFire } from '../src/sim/events';
import { addIndustry, addTown, generateWorld } from '../src/sim/mapgen';
import { acceptanceForRect, suppliesForRect } from '../src/sim/simulate';
import { createEmptyWorld, idx } from '../src/sim/world';


describe('火事', () => {
  it('家だけが燃え、線路や駅はそのまま。数は上限まで', () => {
    const w = createEmptyWorld(30, 30, 3);
    const town = addTown(w, '町', 15, 15);
    for (let y = 12; y <= 18; y++) for (let x = 12; x <= 18; x++) if (x !== 15) w.occ[idx(w, x, y)] = { k: 'house', town: town.id, level: 1, variant: 0 };
    buildTrack(w, idx(w, 15, 5), idx(w, 15, 25));
    const st = buildStation(w, idx(w, 15, 20), idx(w, 15, 21)).id!;
    const track = Array.from(w.track);
    const before = w.occ.filter((o) => o?.k === 'house').length;
    const n = startFire(w, town, idx(w, 14, 14));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(EVENTS.fireMaxHouses);
    expect(w.occ.filter((o) => o?.k === 'house').length).toBe(before - n);
    expect(Array.from(w.track)).toEqual(track);
    expect(w.stations.has(st)).toBe(true);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('火事'))).toBe(true);
  });

  it('火事は町（1,000人）から。村では起きない', () => {
    const w = generateWorld(21);
    const towns = [...w.towns.values()];
    for (const t of towns) t.houses = 60;
    towns[0].population = 5000;
    for (const t of towns.slice(1)) t.population = 500;
    const burned = new Set<number>();
    for (let m = 0; m < 200; m++) {
      w.events = [];
      eventsMonthly(w);
      for (const e of w.events) if (e.type === 'news' && e.text.includes('火事')) burned.add(towns.find((t) => e.text.includes(t.name))!.id);
    }
    expect([...burned]).toEqual([towns[0].id]);
  });
});

describe('駅のプレビュー用の情報', () => {
  it('範囲にある産業と家・受け入れる貨物がわかる', () => {
    const w = createEmptyWorld(30, 30, 3);
    const forest = addIndustry(w, 'forest', '森', 3, 3, 3, 3);
    const saw = addIndustry(w, 'sawmill', '製材所', 9, 3, 3, 2);
    const r = { x0: 0, y0: 0, x1: 12, y1: 10 };
    const sup = suppliesForRect(w, r);
    expect(sup.industries.map((i) => i.id).sort()).toEqual([forest.id, saw.id].sort());
    const acc = acceptanceForRect(w, r, 6, 8);
    expect(acc.by.logs?.length).toBe(1);
    expect(acc.by.lumber).toBeUndefined();
  });
});
