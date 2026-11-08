import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, rename, startStop } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { generateWorld } from '../src/sim/mapgen';
import { deserializeWorld, MAX_SAVE_CHARS, SaveError, serializeWorld, toSaveFile } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld, idx } from '../src/sim/world';

function played() {
  const w = createEmptyWorld(48, 16, 3);
  w.money = 1e9;
  buildTrack(w, idx(w, 1, 7), idx(w, 44, 7));
  const a = buildStation(w, idx(w, 2, 7), idx(w, 3, 7)).id!;
  const b = buildStation(w, idx(w, 40, 7), idx(w, 41, 7)).id!;
  const depot = buildDepot(w, idx(w, 10, 8)).id!;
  const t = buyTrain(w, depot, ['coach', 'coach']).id!;
  addOrder(w, t, a);
  addOrder(w, t, b);
  startStop(w, t);
  rename(w, 'station', a, '<b>いたずら</b>"\'&');
  step(w, 400 * TICKS_PER_DAY);
  return w;
}

const file = () => JSON.parse(serializeWorld(played()));

describe('セーブの検査', () => {
  it('ふつうに遊んだセーブ・新しいマップのセーブは通る', () => {
    expect(() => checkSavedWorld(toSaveFile(played()).world)).not.toThrow();
    const g = generateWorld(42);
    step(g, 200 * TICKS_PER_DAY);
    expect(() => deserializeWorld(serializeWorld(g))).not.toThrow();
  });

  it('車両の種類に文字列を仕込んだセーブは断る', () => {
    const f = file();
    f.world.trains[0].cars[0].type = 'coach" onmouseover="alert(1)';
    expect(() => deserializeWorld(JSON.stringify(f))).toThrow(SaveError);
  });

  it('ID が数でないセーブは断る', () => {
    const f = file();
    f.world.stations[0].id = '1"><img src=x onerror=alert(1)>';
    expect(() => deserializeWorld(JSON.stringify(f))).toThrow(/壊れて/);
  });

  it('長すぎる名前・おかしな数・範囲外のタイルは断る', () => {
    const cases: ((f: any) => void)[] = [
      (f) => (f.world.trains[0].name = 'あ'.repeat(500)),
      (f) => (f.world.money = 'many'),
      (f) => (f.world.stations[0].tiles[0] = 1e9),
      (f) => (f.world.w = 100000),
      (f) => (f.world.industries = [{}]),
      (f) => (f.world.orderLists[0].orders[0].load = 'explode'),
      (f) => (f.world.towns = null),
      (f) => (f.world.occ.push([0, { k: 'house', town: 0, level: 9, variant: 0 }])),
    ];
    for (const c of cases) {
      const f = file();
      c(f);
      expect(() => deserializeWorld(JSON.stringify(f))).toThrow(SaveError);
    }
  });

  it('名前の記号はそのまま読み込める（表示のときにエスケープする）', () => {
    const w = deserializeWorld(serializeWorld(played()));
    expect([...w.stations.values()].some((s) => s.name.includes('<b>'))).toBe(true);
  });

  it('大きすぎるセーブ・形のちがうデータは断る', () => {
    expect(() => deserializeWorld(' '.repeat(MAX_SAVE_CHARS + 1))).toThrow(/大きすぎ/);
    expect(() => deserializeWorld('null')).toThrow(SaveError);
    expect(() => deserializeWorld('[]')).toThrow(SaveError);
    expect(() => deserializeWorld('{"format":"tsunagumachi","version":"4"}')).toThrow(SaveError);
  });
});
