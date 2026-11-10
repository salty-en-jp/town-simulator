import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, startStop } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { addIndustry, addTown, generateWorld } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { acceptorDemand, step } from '../src/sim/simulate';
import { famePaxMul, specialtyKindFor, specialtyMonthly, workshopOf } from '../src/sim/specialty';
import { townAccepts } from '../src/sim/towns';
import { createEmptyWorld, idx, Terrain } from '../src/sim/world';

describe('名産の工房', () => {
  it('新しいマップでは、どの町にも名産の工房がある（地元の産業）', () => {
    for (const lf of ['mixed', 'coast', 'mountains'] as const) {
      const w = generateWorld(41, 96, lf);
      for (const t of w.towns.values()) {
        const ws = workshopOf(w, t.id);
        expect(ws).toBeDefined();
        expect(ws!.owner).toBe('public');
        expect(ws!.name).toContain(t.name);
      }
    }
  });

  it('名産の種類はまわりの土地で決まる', () => {
    const w = createEmptyWorld(40, 40, 1);
    expect(specialtyKindFor(w, 20, 20)).toBe('fruit');
    for (let y = 26; y < 40; y++) for (let x = 0; x < 40; x++) w.terrain[idx(w, x, y)] = Terrain.Water;
    expect(specialtyKindFor(w, 20, 22)).toBe('driedfish');
    const r = createEmptyWorld(40, 40, 1);
    for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) r.terrain[idx(r, x, y)] = Terrain.Rock;
    expect(specialtyKindFor(r, 20, 20)).toBe('pottery');
  });

  it('前の版のセーブ（工房なし）には、毎月1つずつ見つかる', () => {
    const w = generateWorld(42);
    const f = JSON.parse(serializeWorld(w));
    f.world.industries = f.world.industries.filter((i: { type: string }) => i.type !== 'workshop');
    const w2 = deserializeWorld(JSON.stringify(f));
    expect([...w2.industries.values()].some((i) => i.type === 'workshop')).toBe(false);
    specialtyMonthly(w2);
    expect([...w2.industries.values()].filter((i) => i.type === 'workshop').length).toBe(1);
    expect(w2.events.some((e) => e.type === 'news' && e.text.includes('名産'))).toBe(true);
  });
});

describe('名産品を売る', () => {
  it('村では売れず、町・都市では大きいほど高い', () => {
    const w = createEmptyWorld(40, 40, 1);
    const a = addTown(w, 'A', 10, 10);
    const b = addTown(w, 'B', 30, 30);
    a.stage = 0;
    b.stage = 1;
    expect(townAccepts(w, a.id, 'specialty')).toBe(false);
    expect(townAccepts(w, b.id, 'specialty')).toBe(true);
    b.population = 1000;
    const small = acceptorDemand(w, { kind: 'town', id: b.id }, 'specialty');
    b.population = 8000;
    const big = acceptorDemand(w, { kind: 'town', id: b.id }, 'specialty');
    expect(big).toBeGreaterThan(small * 1.5);
  });

  it('生まれた町では降ろさず、よその町で売れる。運び出すと評判が上がり観光客が増える', () => {
    const w = createEmptyWorld(70, 20, 3);
    w.money = 1e10;
    w.requestState.nextCheckDay = 1e9;
    const home = addTown(w, 'ふるさと', 10, 10);
    const far = addTown(w, 'みやこ', 58, 10);
    for (const t of [home, far]) for (let dx = -3; dx <= 3; dx++) w.occ[idx(w, t.cx + dx, t.cy - 3)] = { k: 'house', town: t.id, level: 2, variant: 0 };
    home.stage = 1;
    far.stage = 2;
    const ws = addIndustry(w, 'workshop', 'ふるさとの窯元', 14, 12, 2, 2, 'public');
    ws.specialty = 'pottery';
    ws.town = home.id;
    buildTrack(w, idx(w, 3, 10), idx(w, 66, 10));
    const sa = buildStation(w, idx(w, 14, 10), idx(w, 15, 10)).id!;
    const sb = buildStation(w, idx(w, 57, 10), idx(w, 58, 10)).id!;
    const depot = buildDepot(w, idx(w, 30, 11)).id!;
    const tr = buyTrain(w, depot, ['specialtycar', 'specialtycar']).id!;
    addOrder(w, tr, sa);
    addOrder(w, tr, sb);
    startStop(w, tr);
    step(w, 150 * TICKS_PER_DAY);
    expect(home.recv.specialty?.total ?? 0).toBe(0);
    expect(far.recv.specialty?.total ?? 0).toBeGreaterThan(0);
    expect(home.fame ?? 0).toBeGreaterThan(0);
    expect(famePaxMul(home)).toBeGreaterThan(1);
  });
});
