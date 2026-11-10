import { describe, expect, it } from 'vitest';
import { applyUndo, buildTrack, electrify } from '../src/sim/commands';
import { COSTS } from '../src/sim/constants';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { findPath } from '../src/sim/track';
import { checkSavedWorld } from '../src/sim/validate';
import { createEmptyWorld, ELECTRIFY_YEAR, idx, isElectric, Terrain } from '../src/sim/world';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function lineWorld() {
  const w = createEmptyWorld(30, 16, 3);
  w.money = 1e10;
  w.requestState.nextCheckDay = 1e9;
  buildTrack(w, idx(w, 2, 5), idx(w, 27, 5));
  w.day = dayOfYear(ELECTRIFY_YEAR);
  return w;
}

describe('電化', () => {
  it(`${ELECTRIFY_YEAR}年まではできない`, () => {
    const w = lineWorld();
    w.day = dayOfYear(ELECTRIFY_YEAR - 1);
    const r = electrify(w, idx(w, 2, 5), idx(w, 10, 5));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`${ELECTRIFY_YEAR}`);
  });

  it('線路のあるマスだけに架線を張り、1マスごとに費用がかかる', () => {
    const w = lineWorld();
    const money = w.money;
    const r = electrify(w, idx(w, 0, 5), idx(w, 10, 5));
    expect(r.ok).toBe(true);
    // 線路は x=2..10 の 9マス
    expect(r.cost).toBe(9 * COSTS.electrifyPerTile);
    expect(w.money).toBe(money - r.cost);
    expect(isElectric(w, idx(w, 1, 5))).toBe(false);
    expect(isElectric(w, idx(w, 2, 5))).toBe(true);
    expect(isElectric(w, idx(w, 10, 5))).toBe(true);
    expect(isElectric(w, idx(w, 11, 5))).toBe(false);
    // もう一度は張れない
    expect(electrify(w, idx(w, 2, 5), idx(w, 10, 5)).ok).toBe(false);
    // 線路のないところ
    expect(electrify(w, idx(w, 2, 8), idx(w, 10, 8)).error).toContain('線路');
  });

  it('岩場は高い', () => {
    const w = lineWorld();
    w.terrain[idx(w, 20, 5)] = Terrain.Rock;
    const r = electrify(w, idx(w, 19, 5), idx(w, 21, 5), { dry: true });
    expect(r.cost).toBe(2 * COSTS.electrifyPerTile + Math.round(COSTS.electrifyPerTile * COSTS.trackRockMultiplier));
  });

  it('架線を外せる・線路を外すと架線もなくなる・元に戻せる', () => {
    const w = lineWorld();
    electrify(w, idx(w, 2, 5), idx(w, 20, 5));
    const rm = electrify(w, idx(w, 2, 5), idx(w, 5, 5), { remove: true });
    expect(rm.ok).toBe(true);
    expect(isElectric(w, idx(w, 3, 5))).toBe(false);
    expect(isElectric(w, idx(w, 6, 5))).toBe(true);
    expect(applyUndo(w, rm.undo!).ok).toBe(true);
    expect(isElectric(w, idx(w, 3, 5))).toBe(true);

    const del = buildTrack(w, idx(w, 15, 5), idx(w, 20, 5), { remove: true });
    expect(del.ok).toBe(true);
    expect(isElectric(w, idx(w, 17, 5))).toBe(false);
    expect(applyUndo(w, del.undo!).ok).toBe(true);
    expect(isElectric(w, idx(w, 17, 5))).toBe(true);
  });

  it('電気の車両は電化した線路だけを通る道を探す', () => {
    const w = lineWorld();
    const goal = new Set([idx(w, 20, 5)]);
    expect(findPath(w, idx(w, 2, 5), goal)).not.toBeNull();
    expect(findPath(w, idx(w, 2, 5), goal, true)).toBeNull();
    electrify(w, idx(w, 2, 5), idx(w, 20, 5));
    expect(findPath(w, idx(w, 2, 5), goal, true)).not.toBeNull();
  });

  it('セーブして読み込んでも架線が残る', () => {
    const w = lineWorld();
    electrify(w, idx(w, 4, 5), idx(w, 8, 5));
    const text = serializeWorld(w);
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const w2 = deserializeWorld(text);
    expect(isElectric(w2, idx(w2, 6, 5))).toBe(true);
    expect(isElectric(w2, idx(w2, 9, 5))).toBe(false);
    // 電化していない世界は electric を書かない
    const plain = JSON.parse(serializeWorld(lineWorld()));
    expect(plain.world?.electric ?? plain.electric).toBeUndefined();
  });
});
