import { describe, expect, it } from 'vitest';
import { attachVehicle, buildDepot, buildTrack, buyTrain, buyVehicle, replaceEngine } from '../src/sim/commands';
import { ENGINE_SPECS, TICKS_PER_DAY, WAGON_SPECS } from '../src/sim/constants';
import { generateWorld } from '../src/sim/mapgen';
import { step } from '../src/sim/simulate';
import { canBuy, consistError, createEmptyWorld, idx, type World } from '../src/sim/world';

/** 1960年1月1日からの日数 */
const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function depotWorld() {
  const w = createEmptyWorld(30, 12, 3);
  w.money = 1e10;
  w.requestState.nextCheckDay = 1e9;
  buildTrack(w, idx(w, 2, 5), idx(w, 27, 5));
  const depot = buildDepot(w, idx(w, 10, 6)).id!;
  return { w, depot };
}

describe('年代で登場する車両', () => {
  it('登場の年までは買えず、その年から買える。依頼の報酬で一足早く使える', () => {
    const w = createEmptyWorld(20, 20, 3);
    expect(canBuy(w, 'steam')).toBe(true);
    expect(canBuy(w, 'biglogcar')).toBe(false);
    w.day = dayOfYear(1962);
    expect(canBuy(w, 'biglogcar')).toBe(true);
    expect(canBuy(w, 'superexpress')).toBe(false);
    w.unlocked.add('superexpress');
    expect(canBuy(w, 'superexpress')).toBe(true);
  });

  it('田舎に必要な車両から順に登場する', () => {
    const y = (t: keyof typeof WAGON_SPECS) => WAGON_SPECS[t].year!;
    expect(y('biglogcar')).toBeLessThan(y('bigorecar'));
    expect(y('biggraincar')).toBeLessThan(y('bigsteelcar'));
    expect(y('freshcar')).toBeLessThan(ENGINE_SPECS.superexpress.year!);
    expect(ENGINE_SPECS.heavy.year!).toBeLessThan(ENGINE_SPECS.superexpress.year!);
  });

  it('年が変わると、新しく登場した車両のお知らせが出る', () => {
    const w = generateWorld(3);
    w.requestState.nextCheckDay = 1e9;
    w.day = dayOfYear(1962) - 2;
    step(w, 3 * TICKS_PER_DAY);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('大型原木車'))).toBe(true);
  });
});

describe('機関車の決まり', () => {
  it('超特急は客車だけ、ゴウリキ形は貨車だけ、両数には上限がある', () => {
    expect(consistError('superexpress', ['coach', 'bigcoach'])).toBeNull();
    expect(consistError('superexpress', ['coach', 'logcar'])).toMatch(/客車しか/);
    expect(consistError('heavy', ['coach'])).toMatch(/貨車しか/);
    expect(consistError('heavy', new Array(14).fill('orecar'))).toBeNull();
    expect(consistError('heavy', new Array(15).fill('orecar'))).toMatch(/14両まで/);
    expect(consistError('steam', new Array(9).fill('logcar'))).toMatch(/8両まで/);
  });

  it('買う・つなぐ・機関車の交換でも決まりを守る', () => {
    const { w, depot } = depotWorld();
    w.unlocked.add('superexpress');
    w.unlocked.add('heavy');
    const pax = buyTrain(w, depot, ['coach'], { engine: 'superexpress' }).id!;
    expect(buyVehicle(w, depot, 'logcar', { attachTo: pax }).ok).toBe(false);
    expect(buyVehicle(w, depot, 'coach', { attachTo: pax }).ok).toBe(true);
    const spare = buyVehicle(w, depot, 'graincar').id!;
    expect(attachVehicle(w, depot, spare, pax).ok).toBe(false);
    expect(buyTrain(w, depot, ['coach'], { engine: 'heavy' }).ok).toBe(false);
    // 客車をつないだ列車の機関車を、貨物用には替えられない
    const mixed = buyTrain(w, depot, ['coach', 'logcar']).id!;
    expect(replaceEngine(w, mixed, 'heavy').ok).toBe(false);
    expect(replaceEngine(w, mixed, 'superexpress').ok).toBe(false);
    const freight = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    expect(replaceEngine(w, freight, 'heavy').ok).toBe(true);
  });
});

describe('新型冷蔵車', () => {
  it('食料品が傷みにくい（日数がゆっくり進む）', () => {
    const { w, depot } = depotWorld();
    w.unlocked.add('freshcar');
    const make = (t: 'foodcar' | 'freshcar', world: World) => {
      const id = buyTrain(world, depot, [t]).id!;
      const tr = world.trains.get(id)!;
      tr.cars[1].packets.push({ amount: 10, from: 999, fromTile: 0, days: 0 });
      tr.state = 'running';
      tr.path = [];
      return tr;
    };
    const a = make('foodcar', w);
    const b = make('freshcar', w);
    step(w, 10 * TICKS_PER_DAY);
    const da = a.cars[1].packets[0]?.days ?? 0;
    const db = b.cars[1].packets[0]?.days ?? 0;
    expect(da).toBeGreaterThan(5);
    expect(db).toBeCloseTo(da * 0.5, 1);
  });
});

describe('依頼の報酬', () => {
  it('一足早く解禁した車両は、もう報酬に出ない', () => {
    const w = generateWorld(13);
    for (const t of ['biglogcar', 'biglumbercar', 'biggraincar', 'freshcar', 'heavy', 'bigcoach'] as const) w.unlocked.add(t);
    for (let k = 0; k < 60; k++) {
      if (w.requests.length) w.requests.shift();
      w.requestState.nextCheckDay = w.day;
      step(w, TICKS_PER_DAY);
      for (const r of w.requests) if (r.reward.kind === 'vehicle') expect(w.unlocked.has(r.reward.vehicle)).toBe(false);
    }
  });

  it('ほとんどはお金。車両は「一足早く使える新型」だけ', () => {
    const w = generateWorld(12);
    let money = 0,
      vehicle = 0;
    for (let k = 0; k < 120; k++) {
      // 1件ずつ入れ替わる（ふつうの遊び方と同じく、出ている依頼は残る）
      if (w.requests.length) w.requests.shift();
      w.requestState.nextCheckDay = w.day;
      step(w, TICKS_PER_DAY);
      const r = w.requests.at(-1);
      if (r) {
        if (r.reward.kind === 'money') money++;
        else {
          vehicle++;
          expect(r.reward.unlock).toBe(true);
          expect(canBuy(w, r.reward.vehicle)).toBe(false);
        }
      }
    }
    expect(money).toBeGreaterThan(vehicle * 2);
  });
});
