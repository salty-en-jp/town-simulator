import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, cloneTrain, moveOrder, rename } from '../src/sim/commands';
import { addIndustry, addTown } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { createEmptyWorld, idx, townLabel } from '../src/sim/world';

function world() {
  const w = createEmptyWorld(48, 16, 3);
  w.money = 1e9;
  buildTrack(w, idx(w, 1, 7), idx(w, 44, 7));
  const s = [2, 12, 22, 32].map((x) => buildStation(w, idx(w, x, 7), idx(w, x + 1, 7)).id!);
  const depot = buildDepot(w, idx(w, 10, 8)).id!;
  const t = buyTrain(w, depot, ['coach']).id!;
  for (const st of s) addOrder(w, t, st);
  return { w, s, t, depot };
}

describe('名前の変更', () => {
  it('駅・列車・産業・町の名前を変えられる。町は書いたとおりに表示する', () => {
    const { w, s, t } = world();
    const town = addTown(w, '桜川', 20, 12);
    const ind = addIndustry(w, 'forest', '桜川の森', 40, 1, 3, 3);
    expect(townLabel(town)).toBe('桜川町');
    expect(rename(w, 'station', s[0], '  みなと駅 ').ok).toBe(true);
    expect(w.stations.get(s[0])!.name).toBe('みなと駅');
    expect(rename(w, 'train', t, '木材特急').ok).toBe(true);
    expect(w.trains.get(t)!.name).toBe('木材特急');
    expect(rename(w, 'industry', ind.id, '北の大森林').ok).toBe(true);
    expect(rename(w, 'town', town.id, 'ニュータウン').ok).toBe(true);
    expect(townLabel(town)).toBe('ニュータウン');
    const w2 = deserializeWorld(serializeWorld(w));
    expect(townLabel(w2.towns.get(town.id)!)).toBe('ニュータウン');
  });

  it('空の名前や長すぎる名前はだめ', () => {
    const { w, s } = world();
    expect(rename(w, 'station', s[0], '   ').ok).toBe(false);
    expect(rename(w, 'station', s[0], 'あ'.repeat(21)).ok).toBe(false);
    expect(rename(w, 'station', 9999, 'x').ok).toBe(false);
  });
});

describe('指令の並べ替え', () => {
  it('上下に動かせて、今の行き先はいっしょに動く（共有している列車も）', () => {
    const { w, s, t, depot } = world();
    const t2 = cloneTrain(w, t, depot, true).id!;
    w.trains.get(t)!.curOrder = 1; // s[1] へ向かっている
    w.trains.get(t2)!.curOrder = 2; // s[2] へ向かっている
    expect(moveOrder(w, t, 1, 0).ok).toBe(true);
    const orders = w.orderLists.get(w.trains.get(t)!.orderList)!.orders.map((o) => o.station);
    expect(orders).toEqual([s[1], s[0], s[2], s[3]]);
    expect(orders[w.trains.get(t)!.curOrder]).toBe(s[1]);
    expect(orders[w.trains.get(t2)!.curOrder]).toBe(s[2]);
    expect(moveOrder(w, t, 3, 1).ok).toBe(true);
    const o2 = w.orderLists.get(w.trains.get(t)!.orderList)!.orders.map((o) => o.station);
    expect(o2).toEqual([s[1], s[3], s[0], s[2]]);
    expect(o2[w.trains.get(t)!.curOrder]).toBe(s[1]);
    expect(o2[w.trains.get(t2)!.curOrder]).toBe(s[2]);
    expect(moveOrder(w, t, 0, -1).ok).toBe(false);
  });
});
