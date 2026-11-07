import { describe, expect, it } from 'vitest';
import {
  addOrder,
  attachVehicle,
  buildDepot,
  buildStation,
  buildTrack,
  buyTrain,
  buyVehicle,
  demolish,
  detachVehicle,
  disbandTrain,
  makeTrain,
  sellVehicle,
  sendToDepot,
  startStop,
} from '../src/sim/commands';
import { TICKS_PER_DAY, vehicleCost } from '../src/sim/constants';
import { addIndustry, addTown, generateWorld } from '../src/sim/mapgen';
import { townsConnected, updateRequests, type Request } from '../src/sim/requests';
import { deserializeWorld, serializeWorld, SaveError } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { AXIS_BITS, createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

function depotWorld() {
  const w = createEmptyWorld(32, 16, 3);
  w.money = 500_000_000;
  buildTrack(w, idx(w, 1, 5), idx(w, 20, 5));
  const depot = buildDepot(w, idx(w, 6, 6)).id!;
  return { w, depot };
}

describe('車庫の留置線と編成の組み替え', () => {
  it('貨車を買うと留置線に置かれ、列車につなげる', () => {
    const { w, depot } = depotWorld();
    const tr = buyVehicle(w, depot, 'steam').id!;
    expect(w.trains.get(tr)!.cars.length).toBe(1);
    const car = buyVehicle(w, depot, 'logcar').id!;
    expect(w.depots.get(depot)!.stored.map((c) => c.id)).toEqual([car]);
    expect(attachVehicle(w, depot, car, tr).ok).toBe(true);
    expect(w.trains.get(tr)!.cars.length).toBe(2);
    expect(w.depots.get(depot)!.stored.length).toBe(0);
  });

  it('列車を選んで買うと直接つながる', () => {
    const { w, depot } = depotWorld();
    const tr = buyVehicle(w, depot, 'steam').id!;
    buyVehicle(w, depot, 'lumbercar', { attachTo: tr });
    expect(w.trains.get(tr)!.cars.map((c) => c.type)).toEqual(['steam', 'lumbercar']);
  });

  it('外した貨車は留置線に残り、売らずに別の列車で使える', () => {
    const { w, depot } = depotWorld();
    const a = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    const b = buyTrain(w, depot, ['coach']).id!;
    const car = w.trains.get(a)!.cars[2];
    const money = w.money;
    expect(detachVehicle(w, a, car.id).ok).toBe(true);
    expect(w.money).toBe(money);
    expect(w.depots.get(depot)!.stored[0].id).toBe(car.id);
    expect(attachVehicle(w, depot, car.id, b).ok).toBe(true);
    expect(w.trains.get(b)!.cars.map((c) => c.type)).toEqual(['steam', 'coach', 'logcar']);
  });

  it('機関車は外せない。ばらすと全部留置線へ、機関車からまた列車にできる', () => {
    const { w, depot } = depotWorld();
    const a = buyTrain(w, depot, ['logcar']).id!;
    const engine = w.trains.get(a)!.cars[0];
    expect(detachVehicle(w, a, engine.id).ok).toBe(false);
    expect(disbandTrain(w, a).ok).toBe(true);
    expect(w.trains.has(a)).toBe(false);
    expect(w.depots.get(depot)!.stored.length).toBe(2);
    const t2 = makeTrain(w, depot, engine.id).id!;
    expect(w.trains.get(t2)!.cars[0].id).toBe(engine.id);
  });

  it('走っている列車は組み替えられない', () => {
    const { w, depot } = depotWorld();
    const st1 = buildStation(w, idx(w, 2, 5), idx(w, 3, 5)).id!;
    const st2 = buildStation(w, idx(w, 15, 5), idx(w, 16, 5)).id!;
    const a = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    addOrder(w, a, st1);
    addOrder(w, a, st2);
    startStop(w, a);
    days(w, 1);
    expect(detachVehicle(w, a, w.trains.get(a)!.cars[1].id).ok).toBe(false);
  });

  it('留置線の車両を売ると、年数に応じた額が戻る', () => {
    const { w, depot } = depotWorld();
    const car = buyVehicle(w, depot, 'logcar').id!;
    const m0 = w.money;
    sellVehicle(w, depot, car);
    const newValue = w.money - m0;
    expect(newValue).toBe(Math.round(vehicleCost('logcar') * 0.75));
    const car2 = buyVehicle(w, depot, 'logcar').id!;
    days(w, 365 * 5);
    const m1 = w.money;
    sellVehicle(w, depot, car2);
    expect(w.money - m1).toBeLessThan(newValue);
  });

  it('留置線に車両がある車庫は解体できない', () => {
    const { w, depot } = depotWorld();
    buyVehicle(w, depot, 'logcar');
    const t = w.depots.get(depot)!.tile;
    expect(demolish(w, t, t).ok).toBe(false);
  });

  it('車庫代が毎月かかる', () => {
    const { w } = depotWorld();
    days(w, 40);
    expect(w.finance.thisYear.facilities).toBeLessThan(0);
  });

  it('解禁されていない車両は買えない', () => {
    const { w, depot } = depotWorld();
    expect(buyVehicle(w, depot, 'biglogcar').ok).toBe(false);
    w.unlocked.add('biglogcar');
    expect(buyVehicle(w, depot, 'biglogcar').ok).toBe(true);
  });
});

describe('駅の向き', () => {
  it('1マスの駅は向きを指定できる', () => {
    const w = createEmptyWorld(16, 16, 1);
    const a = buildStation(w, idx(w, 3, 3), idx(w, 3, 3), { axis: 'y' }).id!;
    expect(w.stations.get(a)!.axis).toBe('y');
    expect(w.track[idx(w, 3, 3)]).toBe(AXIS_BITS.y);
    const b = buildStation(w, idx(w, 8, 8), idx(w, 8, 8), { axis: 'x' }).id!;
    expect(w.stations.get(b)!.axis).toBe('x');
  });
});

describe('依頼', () => {
  it('しばらくすると依頼が届き、最大3件まで', () => {
    const w = generateWorld(5);
    days(w, 400);
    expect(w.requests.length).toBeGreaterThan(0);
    expect(w.requests.length).toBeLessThanOrEqual(3);
  });

  it('原木を運び出すと達成し、報酬で車両が解禁される', () => {
    const w = createEmptyWorld(48, 16, 9);
    w.money = 500_000_000;
    const forest = addIndustry(w, 'forest', 'テストの森', 2, 2, 3, 3);
    addIndustry(w, 'sawmill', 'テスト製材所', 20, 2, 3, 2);
    addTown(w, '町', 40, 8);
    buildTrack(w, idx(w, 1, 7), idx(w, 30, 7));
    const s1 = buildStation(w, idx(w, 3, 7), idx(w, 5, 7)).id!;
    const s2 = buildStation(w, idx(w, 20, 7), idx(w, 22, 7)).id!;
    const depot = buildDepot(w, idx(w, 8, 8)).id!;
    const req: Request = {
      id: 999,
      kind: 'haul',
      cargo: 'logs',
      from: forest.name,
      title: 'テスト',
      desc: '',
      target: forest.id,
      target2: -1,
      goal: 40,
      base: forest.transportedTotal,
      progress: 0,
      createdDay: 0,
      deadlineDay: 9999,
      reward: { kind: 'vehicle', vehicle: 'biglogcar', count: 2, unlock: true },
      tile: -1,
    };
    w.requests = [req];
    w.requestState.nextCheckDay = 99999;
    const tr = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    addOrder(w, tr, s1, 'full_any');
    addOrder(w, tr, s2);
    startStop(w, tr);
    days(w, 150);
    expect(w.requestState.completed).toBe(1);
    expect(w.unlocked.has('biglogcar')).toBe(true);
    expect(w.depots.get(depot)!.stored.filter((c) => c.type === 'biglogcar').length).toBe(2);
  });

  it('期限が切れても罰はない', () => {
    const w = createEmptyWorld(16, 16, 2);
    const t = addTown(w, '町', 8, 8);
    w.requests = [
      {
        id: 1,
        kind: 'deliver',
        cargo: 'lumber',
        from: '町',
        title: 'x',
        desc: '',
        target: t.id,
        target2: -1,
        goal: 100,
        base: 0,
        progress: 0,
        createdDay: 0,
        deadlineDay: 1,
        reward: { kind: 'money', amount: 1 },
        tile: -1,
      },
    ];
    w.requestState.nextCheckDay = 99999;
    const money = w.money;
    w.day = 1;
    updateRequests(w);
    expect(w.requests.length).toBe(0);
    expect(w.money).toBe(money);
    expect(w.requestState.expired).toBe(1);
  });

  it('町どうしが線路でつながっているか判定できる', () => {
    const w = createEmptyWorld(40, 12, 1);
    const a = addTown(w, 'A', 4, 6);
    const b = addTown(w, 'B', 34, 6);
    buildStation(w, idx(w, 6, 6), idx(w, 7, 6));
    buildStation(w, idx(w, 31, 6), idx(w, 32, 6));
    expect(townsConnected(w, a.id, b.id)).toBe(false);
    buildTrack(w, idx(w, 7, 6), idx(w, 31, 6));
    expect(townsConnected(w, a.id, b.id)).toBe(true);
  });
});

describe('セーブ', () => {
  it('保存して読み込んだ後も、まったく同じように時間が進む', () => {
    const w = generateWorld(77);
    w.money = 500_000_000;
    const forest = [...w.industries.values()].find((i) => i.type === 'forest')!;
    const saw = [...w.industries.values()].find((i) => i.type === 'sawmill')!;
    const fy = forest.y + forest.h + 1,
      sy = saw.y + saw.h + 1;
    const s1 = buildStation(w, idx(w, forest.x, fy), idx(w, forest.x + 2, fy)).id!;
    const s2 = buildStation(w, idx(w, saw.x, sy), idx(w, saw.x + 2, sy)).id!;
    expect(buildTrack(w, idx(w, forest.x + 2, fy), idx(w, saw.x, sy)).ok).toBe(true);
    let depot = -1;
    for (let dx = -2; dx <= 2 && depot < 0; dx++) {
      const r = buildDepot(w, idx(w, forest.x + 1 + dx, fy + 1));
      if (r.ok) depot = r.id!;
    }
    expect(depot).toBeGreaterThan(0);
    const tr = buyTrain(w, depot, ['logcar', 'logcar']).id!;
    buyVehicle(w, depot, 'coach');
    addOrder(w, tr, s1, 'full_any');
    addOrder(w, tr, s2);
    startStop(w, tr);
    days(w, 120);

    const text = serializeWorld(w);
    const w2 = deserializeWorld(text);
    expect(serializeWorld(w2).replace(/"savedAt":"[^"]+"/, '')).toBe(text.replace(/"savedAt":"[^"]+"/, ''));
    days(w, 200);
    days(w2, 200);
    const strip = (s: string) => s.replace(/"savedAt":"[^"]+"/, '');
    expect(strip(serializeWorld(w2))).toBe(strip(serializeWorld(w)));
    expect(w2.depots.get(depot)!.stored.length).toBe(w.depots.get(depot)!.stored.length);
    expect(w2.depots.get(depot)!.stored.length).toBeGreaterThanOrEqual(1);
  });

  it('壊れたデータや別のデータは、わかりやすいエラーになる', () => {
    expect(() => deserializeWorld('not json')).toThrow(SaveError);
    expect(() => deserializeWorld('{"format":"other"}')).toThrow(SaveError);
    expect(() => deserializeWorld(JSON.stringify({ format: 'tsunagumachi', version: 999 }))).toThrow(/新しい版/);
  });
});

describe('車庫の撤去と「車庫へ送る」', () => {
  it('買った車庫を撤去しても、いちばん近い車庫に帰れる', () => {
    const w = createEmptyWorld(40, 12, 5);
    w.money = 500_000_000;
    buildTrack(w, idx(w, 1, 5), idx(w, 35, 5));
    const s1 = buildStation(w, idx(w, 2, 5), idx(w, 3, 5)).id!;
    const s2 = buildStation(w, idx(w, 30, 5), idx(w, 31, 5)).id!;
    const d1 = buildDepot(w, idx(w, 10, 6)).id!;
    const tr = buyTrain(w, d1, ['coach']).id!;
    addOrder(w, tr, s1);
    addOrder(w, tr, s2);
    startStop(w, tr);
    days(w, 2);
    const t1 = w.depots.get(d1)!.tile;
    expect(demolish(w, t1, t1).ok).toBe(true);
    const d2 = buildDepot(w, idx(w, 20, 4)).id!;
    expect(sendToDepot(w, tr).ok).toBe(true);
    days(w, 30);
    const t = w.trains.get(tr)!;
    expect(t.state).toBe('in_depot');
    expect(t.depotId).toBe(d2);
    // 新しい車庫で編成を変えられる
    expect(buyVehicle(w, d2, 'coach', { attachTo: tr }).ok).toBe(true);
  });

  it('車庫がひとつもなければ送れない', () => {
    const w = createEmptyWorld(40, 12, 5);
    w.money = 500_000_000;
    buildTrack(w, idx(w, 1, 5), idx(w, 35, 5));
    const s1 = buildStation(w, idx(w, 2, 5), idx(w, 3, 5)).id!;
    const s2 = buildStation(w, idx(w, 30, 5), idx(w, 31, 5)).id!;
    const d1 = buildDepot(w, idx(w, 10, 6)).id!;
    const tr = buyTrain(w, d1, ['coach']).id!;
    addOrder(w, tr, s1);
    addOrder(w, tr, s2);
    startStop(w, tr);
    days(w, 2);
    const t1 = w.depots.get(d1)!.tile;
    demolish(w, t1, t1);
    expect(sendToDepot(w, tr).ok).toBe(false);
  });
});
