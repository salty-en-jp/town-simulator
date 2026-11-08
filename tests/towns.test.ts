import { describe, expect, it } from 'vitest';
import { buildStation, buildTrack } from '../src/sim/commands';
import { TICKS_PER_DAY, TOWN } from '../src/sim/constants';
import { addTown, generateWorld } from '../src/sim/mapgen';
import { startFire } from '../src/sim/events';
import { boomMul } from '../src/sim/market';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { acceptors, step } from '../src/sim/simulate';
import { stageForPop, townAccepts, townStage, updateTownStage } from '../src/sim/towns';
import { createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

function townWithStation() {
  const w = createEmptyWorld(40, 30, 3);
  w.money = 1e9;
  w.requestState.nextCheckDay = 1e9;
  const t = addTown(w, '町', 20, 15);
  for (let x = 16; x <= 24; x++) for (const y of [13, 17]) w.occ[idx(w, x, y)] = { k: 'house', town: t.id, level: 1, variant: 0 };
  buildTrack(w, idx(w, 2, 15), idx(w, 38, 15));
  const st = buildStation(w, idx(w, 19, 15), idx(w, 20, 15)).id!;
  return { w, t, st };
}

describe('町の段階', () => {
  it('人口で 村 → 町 → 都市', () => {
    expect(stageForPop(999)).toBe(0);
    expect(stageForPop(1000)).toBe(1);
    expect(stageForPop(5000)).toBe(2);
  });

  it('村は木材、都市は建設資材だけ（木材は受け入れない）', () => {
    const { w, t, st } = townWithStation();
    t.stage = 0;
    w.version++;
    expect(townAccepts(w, t.id, 'lumber')).toBe(true);
    expect(townAccepts(w, t.id, 'materials')).toBe(false);
    expect(acceptors(w, w.stations.get(st)!, 'lumber').some((a) => a.kind === 'town')).toBe(true);
    t.stage = 2;
    w.version++;
    expect(townAccepts(w, t.id, 'lumber')).toBe(false);
    expect(townAccepts(w, t.id, 'materials')).toBe(true);
    expect(townAccepts(w, t.id, 'food')).toBe(true);
    expect(acceptors(w, w.stations.get(st)!, 'lumber').some((a) => a.kind === 'town')).toBe(false);
  });

  it('段階は上がるだけ。都市の前にお知らせが出る', () => {
    const { w, t } = townWithStation();
    t.stage = 1;
    t.cityWarned = false;
    t.population = 4600;
    updateTownStage(w, t);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('もうすぐ都市'))).toBe(true);
    t.population = 5200;
    expect(updateTownStage(w, t)).toBe(true);
    expect(t.stage).toBe(2);
    t.population = 4000; // 火事などで減っても下がらない
    expect(updateTownStage(w, t)).toBe(false);
    expect(townStage(t)).toBe(2);
  });

  it('前の版のセーブは、いまの人口で段階が決まる（お知らせなし）', () => {
    const w = generateWorld(4);
    const f = JSON.parse(serializeWorld(w));
    for (const t of f.world.towns) {
      delete t.stage;
      t.population = 6000;
    }
    const w2 = deserializeWorld(JSON.stringify(f));
    const t = [...w2.towns.values()][0];
    expect(updateTownStage(w2, t)).toBe(true);
    expect(t.stage).toBe(2);
    expect(w2.events.length).toBe(0);
  });

  it('村では木材で家が建つが、ビルは建たない', () => {
    const { w, t } = townWithStation();
    t.stage = 0;
    t.stock.lumber = 200;
    t.stock.materials = 200;
    days(w, 20);
    expect(w.occ.some((o) => o?.k === 'house' && o.level === 3)).toBe(false);
    expect(t.stock.lumber!).toBeLessThan(200);
  });

  it('材料が山ほど届いても、建つのは数日に1軒（すぐにビルだらけにならない）', () => {
    const { w, t } = townWithStation();
    t.stage = 2;
    t.stock.materials = TOWN.materialsPerUpgrade3 * 100;
    days(w, 40);
    const used = (TOWN.materialsPerUpgrade3 * 100 - t.stock.materials!) / TOWN.materialsPerUpgrade3;
    expect(used).toBeGreaterThanOrEqual(3);
    expect(used).toBeLessThanOrEqual(6);
  });

  it('都市の火事のあとは、建設資材だけ高くなる', () => {
    const w = createEmptyWorld(30, 30, 3);
    const town = addTown(w, '町', 15, 15);
    for (let y = 12; y <= 18; y++) for (let x = 12; x <= 18; x++) w.occ[idx(w, x, y)] = { k: 'house', town: town.id, level: 1, variant: 0 };
    town.stage = 2;
    startFire(w, town, idx(w, 14, 14));
    const a = { kind: 'town' as const, id: town.id };
    expect(boomMul(w, a, 'materials')).toBeGreaterThan(1.3);
    expect(boomMul(w, a, 'lumber')).toBe(1);
  });
});
