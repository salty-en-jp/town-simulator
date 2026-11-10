import { describe, expect, it } from 'vitest';
import { buildDepot, buildTrack, buyTrain } from '../src/sim/commands';
import { ENGINE_SPECS, isEngine, TICKS_PER_DAY } from '../src/sim/constants';
import {
  chooseTest,
  compatMark,
  currentDesign,
  DEV,
  designSpec,
  devKey,
  engineList,
  fixDefect,
  startDesign,
  type Design,
} from '../src/sim/devel';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld, idx, needsWire } from '../src/sim/world';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function world() {
  const w = createEmptyWorld(30, 16, 3);
  w.money = 1e10;
  w.requestState.nextCheckDay = 1e9;
  return w;
}

/** 試験はいつも同じ方針で答えながら、完成まで進める */
function develop(w: ReturnType<typeof world>, d: Design, choice: 'safe' | 'bold' | 'daring' = 'safe') {
  for (let i = 0; i < 2000 && d.done === undefined; i++) {
    if (d.waiting) chooseTest(w, d.id, choice);
    step(w, TICKS_PER_DAY);
  }
}

describe('自社開発', () => {
  it('開発費を払ってはじめ、試験で止まり、方針を選ぶと進み、完成すると車庫で買える', () => {
    const w = world();
    const money = w.money;
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'freight', budget: 0 }) as Design;
    expect(typeof d).toBe('object');
    expect(w.money).toBe(money - DEV.budgets[0].cost);
    // 同時にはひとつだけ
    expect(typeof startDesign(w, { name: 'X', power: 'diesel', use: 'freight', budget: 0 })).toBe('string');
    // 30% で試運転。選ぶまで止まる
    step(w, TICKS_PER_DAY * 40);
    expect(d.waiting).toBe(true);
    const p = d.progress;
    step(w, TICKS_PER_DAY * 10);
    expect(d.progress).toBe(p);
    expect(chooseTest(w, d.id, 'safe')).not.toBeNull();
    develop(w, d);
    expect(d.done).toBeDefined();
    expect(d.tests.length).toBe(2);
    expect(d.rating).toBeGreaterThanOrEqual(1);
    expect(currentDesign(w)).toBeUndefined();
    const key = devKey(d);
    expect(isEngine(key)).toBe(true);
    expect(engineList(w)).toContain(key);
    expect(ENGINE_SPECS[key].allow).toBe('freight');
    // 列車にして走らせられる
    buildTrack(w, idx(w, 2, 5), idx(w, 27, 5));
    const depot = buildDepot(w, idx(w, 10, 6)).id!;
    const r = buyTrain(w, depot, ['logcar'], { engine: key });
    expect(r.ok).toBe(true);
  });

  it('予算が大きく、相性がよいほど能力が高い', () => {
    const a = world();
    const small = startDesign(a, { name: 'A', power: 'steam', use: 'express', budget: 0 }) as Design;
    develop(a, small);
    const b = world();
    b.day = dayOfYear(1966);
    const big = startDesign(b, { name: 'B', power: 'electric', use: 'express', budget: 2 }) as Design;
    develop(b, big);
    expect(designSpec(big).speed).toBeGreaterThan(designSpec(small).speed);
    expect(compatMark('electric', 'express')).toBe('◎');
    expect(compatMark('steam', 'express')).toBe('△');
    expect(compatMark('steam', 'tourist')).toBe('◎');
  });

  it('電気は電化の年から。電気の機関車は電化した線路だけを走る', () => {
    const w = world();
    expect(startDesign(w, { name: 'E', power: 'electric', use: 'commuter', budget: 0 })).toContain('1965');
    w.day = dayOfYear(1965);
    const d = startDesign(w, { name: 'E', power: 'electric', use: 'commuter', budget: 0 }) as Design;
    develop(w, d);
    expect(needsWire({ cars: [{ type: devKey(d) }] } as never)).toBe(true);
  });

  it('大胆に失敗すると初期不良。改修すると維持費が下がる', () => {
    const w = world();
    let d: Design | undefined;
    // 乱数しだいなので、失敗するまで何度か試す
    for (let k = 0; k < 20; k++) {
      const x = startDesign(w, { name: `T${k}`, power: 'diesel', use: 'commuter', budget: 0 }) as Design;
      develop(w, x, 'daring');
      if (x.defect) {
        d = x;
        break;
      }
    }
    expect(d).toBeDefined();
    const before = ENGINE_SPECS[devKey(d!)].runningCostPerYear;
    expect(fixDefect(w, d!.id)).toBeNull();
    expect(ENGINE_SPECS[devKey(d!)].runningCostPerYear).toBeLessThan(before);
  });

  it('セーブして読み込んでも、自社開発の機関車と開発中のものが残る', () => {
    const w = world();
    const d = startDesign(w, { name: 'D10形', power: 'diesel', use: 'mountain', budget: 0 }) as Design;
    develop(w, d);
    buildTrack(w, idx(w, 2, 5), idx(w, 27, 5));
    const depot = buildDepot(w, idx(w, 10, 6)).id!;
    expect(buyTrain(w, depot, ['coach'], { engine: devKey(d) }).ok).toBe(true);
    startDesign(w, { name: 'D20形', power: 'diesel', use: 'freight', budget: 1 });
    step(w, TICKS_PER_DAY * 5);
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const text = serializeWorld(w);
    // 新しいゲームを始めると、前の街の機関車は表から消える
    createEmptyWorld(20, 20, 1);
    expect(isEngine(devKey(d))).toBe(false);
    const w2 = deserializeWorld(text);
    expect(isEngine(devKey(d))).toBe(true);
    expect(w2.designs!.length).toBe(2);
    expect(currentDesign(w2)!.name).toBe('D20形');
    // 開発記録にない自社開発の機関車は、検査ではねる
    const bad = JSON.parse(text);
    bad.world.designs = [];
    expect(() => deserializeWorld(JSON.stringify(bad))).toThrow();
  });
});
