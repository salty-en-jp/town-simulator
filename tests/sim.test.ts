import { describe, expect, it } from 'vitest';
import {
  addOrder,
  applyUndo,
  buildDepot,
  buildStation,
  buildTrack,
  buyTrain,
  cloneTrain,
  demolish,
  sellTrain,
  sendToDepot,
  startStop,
} from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { cargoIncome, demandFactor, timeFactor } from '../src/sim/economy';
import { addIndustry, addTown, generateWorld } from '../src/sim/mapgen';
import { acceptance, step } from '../src/sim/simulate';
import { dragLine, findPath } from '../src/sim/track';
import { createEmptyWorld, E, idx, N, S, Terrain, W, type World } from '../src/sim/world';

const days = (world: World, n: number) => step(world, n * TICKS_PER_DAY);

describe('運賃', () => {
  it('決まった日数までは満額、超えると減る', () => {
    expect(timeFactor(0, 10, 20)).toBe(1);
    expect(timeFactor(10, 10, 20)).toBe(1);
    expect(timeFactor(20, 10, 20)).toBeCloseTo(245 / 255);
    // days1 + days2 を超えると 1日 -2
    expect(timeFactor(40, 10, 20)).toBeCloseTo((255 - 30 - 10) / 255);
    // 下限
    expect(timeFactor(10_000, 10, 20)).toBeCloseTo(31 / 255);
  });

  it('在庫が少ない届け先ほど高く買う', () => {
    expect(demandFactor(0)).toBeCloseTo(1.8);
    expect(demandFactor(500)).toBeCloseTo(0.5);
    expect(demandFactor(250)).toBeGreaterThan(demandFactor(400));
  });

  it('距離と量に比例する', () => {
    const a = cargoIncome('logs', 30, 10, 0);
    expect(cargoIncome('logs', 30, 20, 0)).toBe(a * 2);
    expect(cargoIncome('logs', 60, 10, 0)).toBe(a * 2);
  });
});

describe('線路', () => {
  it('ドラッグは長い方の軸を先に進むL字になる', () => {
    const w = createEmptyWorld(16, 16, 1);
    const line = dragLine(w, idx(w, 1, 1), idx(w, 5, 3));
    expect(line[0]).toBe(idx(w, 1, 1));
    expect(line[4]).toBe(idx(w, 5, 1));
    expect(line[line.length - 1]).toBe(idx(w, 5, 3));
  });

  it('引いた線路の上を経路探索できる', () => {
    const w = createEmptyWorld(16, 16, 1);
    expect(buildTrack(w, idx(w, 1, 1), idx(w, 8, 4)).ok).toBe(true);
    const p = findPath(w, idx(w, 1, 1), new Set([idx(w, 8, 4)]));
    expect(p).not.toBeNull();
    expect(p!.length).toBe(11);
    expect(w.track[idx(w, 8, 1)]).toBe(W | S);
  });

  it('Shift の見積もりでは何も変わらない', () => {
    const w = createEmptyWorld(16, 16, 1);
    const money = w.money;
    const r = buildTrack(w, idx(w, 1, 1), idx(w, 5, 1), { dry: true });
    expect(r.ok).toBe(true);
    expect(r.cost).toBeGreaterThan(0);
    expect(w.money).toBe(money);
    expect(w.track[idx(w, 2, 1)]).toBe(0);
  });

  it('水の上は高い（橋）', () => {
    const w = createEmptyWorld(16, 16, 1);
    const land = buildTrack(w, idx(w, 1, 1), idx(w, 3, 1), { dry: true }).cost;
    w.terrain[idx(w, 2, 2)] = Terrain.Water;
    const water = buildTrack(w, idx(w, 1, 2), idx(w, 3, 2), { dry: true }).cost;
    expect(water).toBeGreaterThan(land * 3);
  });

  it('Ctrl で撤去、元に戻すで建設前に戻りお金も戻る', () => {
    const w = createEmptyWorld(16, 16, 1);
    const money = w.money;
    const r = buildTrack(w, idx(w, 1, 1), idx(w, 6, 1));
    expect(w.money).toBe(money - r.cost);
    const rm = buildTrack(w, idx(w, 2, 1), idx(w, 4, 1), { remove: true });
    expect(rm.ok).toBe(true);
    expect(w.track[idx(w, 3, 1)]).toBe(0);
    expect(applyUndo(w, rm.undo!).ok).toBe(true);
    expect(w.track[idx(w, 3, 1)]).toBe(E | W);
    expect(applyUndo(w, r.undo!).ok).toBe(true);
    expect(w.track[idx(w, 3, 1)]).toBe(0);
    expect(w.money).toBe(money);
  });

  it('後から変更されたものは元に戻せない', () => {
    const w = createEmptyWorld(16, 16, 1);
    const r = buildTrack(w, idx(w, 1, 1), idx(w, 6, 1));
    buildTrack(w, idx(w, 6, 1), idx(w, 6, 5));
    expect(applyUndo(w, r.undo!).ok).toBe(false);
  });
});

describe('駅と車庫', () => {
  it('隣に置いた駅は同じ駅になる', () => {
    const w = createEmptyWorld(16, 16, 1);
    addTown(w, 'テスト', 8, 8);
    const a = buildStation(w, idx(w, 2, 2), idx(w, 4, 2));
    const b = buildStation(w, idx(w, 5, 2), idx(w, 5, 2));
    expect(a.ok && b.ok).toBe(true);
    expect(b.id).toBe(a.id);
    expect(w.stations.get(a.id!)!.tiles.length).toBe(4);
    expect(w.stations.get(a.id!)!.name).toContain('テスト');
  });

  it('車庫は線路の隣にだけ置ける', () => {
    const w = createEmptyWorld(16, 16, 1);
    expect(buildDepot(w, idx(w, 3, 3)).ok).toBe(false);
    buildTrack(w, idx(w, 1, 2), idx(w, 6, 2));
    const d = buildDepot(w, idx(w, 3, 3));
    expect(d.ok).toBe(true);
    expect(w.track[idx(w, 3, 3)]).toBe(N);
    expect(w.track[idx(w, 3, 2)] & S).toBe(S);
  });

  it('指令で使っている駅は解体できない', () => {
    const w = createEmptyWorld(16, 16, 1);
    buildTrack(w, idx(w, 1, 2), idx(w, 8, 2));
    const st = buildStation(w, idx(w, 2, 2), idx(w, 3, 2));
    const dep = buildDepot(w, idx(w, 5, 3));
    const tr = buyTrain(w, dep.id!, ['coach']);
    addOrder(w, tr.id!, st.id!);
    expect(demolish(w, idx(w, 2, 2), idx(w, 3, 2)).ok).toBe(false);
  });
});

/** 森 → 製材所 → 町 の小さな世界 */
function chainWorld() {
  const w = createEmptyWorld(48, 16, 7);
  w.money = 500_000_000;
  const town = addTown(w, '終点', 42, 6);
  const forest = addIndustry(w, 'forest', 'テストの森', 2, 2, 3, 3);
  const saw = addIndustry(w, 'sawmill', 'テスト製材所', 20, 2, 3, 2);
  // 町に家を数軒
  for (const [x, y] of [
    [41, 5],
    [42, 5],
    [43, 6],
    [41, 7],
  ]) {
    w.occ[idx(w, x, y)] = { k: 'house', town: town.id, level: 1, variant: 0 };
  }
  buildTrack(w, idx(w, 1, 7), idx(w, 40, 7));
  const stForest = buildStation(w, idx(w, 3, 7), idx(w, 5, 7)).id!;
  const stSaw = buildStation(w, idx(w, 20, 7), idx(w, 22, 7)).id!;
  const stTown = buildStation(w, idx(w, 38, 7), idx(w, 40, 7)).id!;
  const depot = buildDepot(w, idx(w, 8, 8)).id!;
  return { w, town, forest, saw, stForest, stSaw, stTown, depot };
}

describe('物流チェーン', () => {
  it('駅の受け入れ判定', () => {
    const { w, stForest, stSaw, stTown } = chainWorld();
    expect(acceptance(w, w.stations.get(stSaw)!).logs).toBe(true);
    expect(acceptance(w, w.stations.get(stForest)!).logs).toBe(false);
    expect(acceptance(w, w.stations.get(stTown)!).lumber).toBe(true);
  });

  it('原木を製材所へ運ぶとお金が入り、製材所が木材を作る', () => {
    const { w, saw, forest, stForest, stSaw, depot } = chainWorld();
    const tr = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    addOrder(w, tr, stForest, 'full_any');
    addOrder(w, tr, stSaw);
    expect(startStop(w, tr).ok).toBe(true);
    const incomeBefore = w.finance.thisYear.income;
    days(w, 120);
    expect(w.finance.thisYear.income + w.finance.lastYear.income).toBeGreaterThan(incomeBefore);
    expect(saw.receivedThisMonth + saw.receivedLastMonth + saw.inStock).toBeGreaterThan(0);
    expect(saw.outStock + saw.producedLastMonth + saw.producedThisMonth).toBeGreaterThan(0);
    expect(forest.transportedLastMonth).toBeGreaterThan(0);
    expect(w.events.some((e) => e.type === 'income')).toBe(true);
  });

  it('木材を町へ運ぶと家が増える', () => {
    const { w, town, stSaw, stTown, depot, saw } = chainWorld();
    saw.outStock = 400;
    const tr = buyTrain(w, depot, ['lumbercar', 'lumbercar', 'lumbercar']).id!;
    addOrder(w, tr, stSaw, 'full_any');
    addOrder(w, tr, stTown);
    startStop(w, tr);
    const housesBefore = town.houses || 4;
    days(w, 90);
    expect(town.lumberReceivedThisMonth + town.lumberReceivedLastMonth + town.lumber).toBeGreaterThan(0);
    expect(town.houses).toBeGreaterThan(housesBefore);
  });

  it('列車がいるタイルの線路は撤去できない', () => {
    const { w, stForest, stSaw, depot } = chainWorld();
    const tr = buyTrain(w, depot, ['logcar']).id!;
    addOrder(w, tr, stForest);
    addOrder(w, tr, stSaw);
    startStop(w, tr);
    days(w, 1);
    const t = w.trains.get(tr)!;
    const here = t.path[0];
    const r = demolish(w, here, here);
    expect(r.ok).toBe(false);
  });

  it('クローン（指令共有）と車庫へ送る・売却', () => {
    const { w, stForest, stSaw, depot } = chainWorld();
    const tr = buyTrain(w, depot, ['logcar']).id!;
    addOrder(w, tr, stForest);
    addOrder(w, tr, stSaw);
    const c = cloneTrain(w, tr, depot, true).id!;
    expect(w.trains.get(c)!.orderList).toBe(w.trains.get(tr)!.orderList);
    const c2 = cloneTrain(w, tr, depot, false).id!;
    expect(w.trains.get(c2)!.orderList).not.toBe(w.trains.get(tr)!.orderList);
    startStop(w, tr);
    days(w, 3);
    sendToDepot(w, tr);
    days(w, 30);
    expect(w.trains.get(tr)!.state).toBe('in_depot');
    const money = w.money;
    expect(sellTrain(w, tr).ok).toBe(true);
    expect(w.money).toBeGreaterThan(money);
  });
});

describe('マップ生成', () => {
  it('同じシードなら同じマップ', () => {
    const a = generateWorld(42);
    const b = generateWorld(42);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(a.towns.size).toBe(2);
    expect(a.industries.size).toBe(2);
    expect([...a.towns.values()].every((t) => t.houses > 5)).toBe(true);
  });

  it('1年進めても壊れない', () => {
    const w = generateWorld(3);
    days(w, 365);
    expect(Number.isFinite(w.money)).toBe(true);
  });
});

describe('L字の向きの自動選択', () => {
  it('駅の端からドラッグすると、駅の向きに合う曲がり方を選ぶ', () => {
    const w = createEmptyWorld(32, 32, 1);
    buildStation(w, idx(w, 2, 2), idx(w, 4, 2)); // 横向きの駅
    // 縦に長いドラッグ：ふつうは縦から進むが、駅の向き（横）に合わせて横から進む
    const r = buildTrack(w, idx(w, 4, 2), idx(w, 7, 20));
    expect(r.ok).toBe(true);
    expect(w.track[idx(w, 5, 2)] & W).toBe(W);
    expect(findPath(w, idx(w, 2, 2), new Set([idx(w, 7, 20)]))).not.toBeNull();
  });
});

describe('Z字', () => {
  it('同じ向きの駅2つを1回のドラッグでつなげる', () => {
    const w = createEmptyWorld(32, 32, 1);
    buildStation(w, idx(w, 2, 2), idx(w, 4, 2));
    buildStation(w, idx(w, 10, 20), idx(w, 12, 20));
    const r = buildTrack(w, idx(w, 4, 2), idx(w, 10, 20));
    expect(r.ok).toBe(true);
    expect(findPath(w, idx(w, 2, 2), new Set([idx(w, 12, 20)]))).not.toBeNull();
  });
});
