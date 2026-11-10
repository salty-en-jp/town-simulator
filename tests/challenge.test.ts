import { describe, expect, it } from 'vitest';
import {
  challengeProgress,
  checkChallengeEnd,
  createChallengeWorld,
  dailyChallenge,
  METRICS,
  randomChallenge,
  STAGES,
  starsFor,
} from '../src/sim/challenge';
import { borrow, buildDepot, buildTrack, buyVehicle } from '../src/sim/commands';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { deserializeWorld, SaveError, serializeWorld } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { canBuy, idx } from '../src/sim/world';

describe('ステージ', () => {
  it('8つ。目標は★1＜★2＜★3、IDは重ならない', () => {
    expect(STAGES.length).toBe(8);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(8);
    for (const s of STAGES) {
      expect(s.goals[0]).toBeLessThan(s.goals[1]);
      expect(s.goals[1]).toBeLessThan(s.goals[2]);
      expect(METRICS[s.metric]).toBeDefined();
    }
  });

  it('★は達成度で決まる（失敗なし：0もある）', () => {
    const d = { goals: [10, 20, 30] as [number, number, number] };
    expect(starsFor(d, 0)).toBe(0);
    expect(starsFor(d, 10)).toBe(1);
    expect(starsFor(d, 25)).toBe(2);
    expect(starsFor(d, 31)).toBe(3);
  });
});

describe('今日のステージ・ランダムステージ', () => {
  it('同じ日なら同じステージ、ちがう日ならちがう', () => {
    const a = dailyChallenge(new Date(2026, 10, 10));
    const b = dailyChallenge(new Date(2026, 10, 10, 23, 59));
    const c = dailyChallenge(new Date(2026, 10, 11));
    expect(a).toEqual(b);
    expect(a.id).toBe('daily-20261110');
    expect(c.id).not.toBe(a.id);
  });

  it('ランダムは数（seed）で決まり、目標の順番は正しい', () => {
    expect(randomChallenge(42)).toEqual(randomChallenge(42));
    const seen = new Set<string>();
    for (let s = 1; s < 60; s++) {
      const r = randomChallenge(s * 1013);
      seen.add(r.metric);
      expect(r.goals[0]).toBeLessThanOrEqual(r.goals[1]);
      expect(r.goals[1]).toBeLessThanOrEqual(r.goals[2]);
      expect(r.years).toBeGreaterThanOrEqual(2);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe('遊ぶ', () => {
  it('しばり：借入なし・ツナグ形だけ', () => {
    const w = createChallengeWorld({ ...STAGES[4] });
    expect(w.loan).toBe(0);
    expect(w.money).toBe(30_000_000);
    expect(borrow(w).ok).toBe(false);
    const w2 = createChallengeWorld({ ...STAGES[6] });
    w2.unlocked.add('express');
    expect(canBuy(w2, 'express')).toBe(false);
    w2.money = 1e9;
    buildTrack(w2, idx(w2, 5, 5), idx(w2, 20, 5));
    const d = buildDepot(w2, idx(w2, 10, 6));
    if (d.ok) expect(buyVehicle(w2, d.id!, 'express').error).toMatch(/ツナグ形だけ/);
  });

  it('期限が来ると1回だけ終わりになる。進み具合がわかる', () => {
    const w = createChallengeWorld({ ...STAGES[0], years: 0.1 });
    const p = challengeProgress(w)!;
    expect(p.stars).toBe(0);
    expect(p.next).toBe(STAGES[0].goals[0]);
    expect(checkChallengeEnd(w)).toBe(false);
    step(w, 40 * TICKS_PER_DAY);
    expect(checkChallengeEnd(w)).toBe(true);
    expect(checkChallengeEnd(w)).toBe(false);
  });

  it('チャレンジはセーブに残り、こわれたチャレンジは読み込まない', () => {
    const w = createChallengeWorld(dailyChallenge(new Date(2026, 0, 2)));
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.challenge).toEqual(w.challenge);
    const f = JSON.parse(serializeWorld(w));
    f.world.challenge.metric = 'cheat';
    expect(() => deserializeWorld(JSON.stringify(f))).toThrow(SaveError);
  });
});
