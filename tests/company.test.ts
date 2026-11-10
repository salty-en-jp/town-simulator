import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, companyMonthly, companyValue, RANKS, rankFor } from '../src/sim/company';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { generateWorld } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { step } from '../src/sim/simulate';

describe('会社のランク', () => {
  it('会社の価値と、つないだ町の人口の両方がそろうと上がる', () => {
    expect(rankFor(0, 0)).toBe(0);
    expect(rankFor(RANKS[2].value, RANKS[1].pop)).toBe(1);
    expect(rankFor(RANKS[2].value, RANKS[2].pop)).toBe(2);
    expect(rankFor(1e12, 1e6)).toBe(RANKS.length - 1);
  });

  it('上がると借入の上限が増え、お金が減っても下がらない', () => {
    const w = generateWorld(5);
    const towns = [...w.towns.values()];
    for (const t of towns) {
      t.activeStations = 1;
      t.population = 2000;
    }
    w.money = 1e9;
    companyMonthly(w);
    expect(w.rank).toBeGreaterThanOrEqual(2);
    expect(w.maxLoan).toBeGreaterThanOrEqual(RANKS[2].maxLoan);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('ランク'))).toBe(true);
    const r = w.rank;
    w.money = 0;
    companyMonthly(w);
    expect(w.rank).toBe(r);
  });

  it('会社の価値＝お金 − 借入 ＋ 車両 ＋ 自社の産業', () => {
    const w = generateWorld(6);
    const base = companyValue(w);
    w.money += 1000;
    expect(companyValue(w)).toBe(base + 1000);
    [...w.industries.values()][0].owner = 'player';
    expect(companyValue(w)).toBeGreaterThan(base + 1000);
  });
});

describe('実績', () => {
  it('取れたら日付が残り、二度は取れない。いくつも取れたらお知らせは1つ', () => {
    const w = generateWorld(7);
    for (const t of w.towns.values()) {
      t.activeStations = 1;
      t.population = 12000;
      t.stage = 2;
    }
    w.requestState.completed = 12;
    w.loan = 0;
    w.day = 400;
    companyMonthly(w);
    const got = Object.keys(w.achievements!);
    expect(got).toContain('city');
    expect(got).toContain('metropolis');
    expect(got).toContain('all_towns');
    expect(got).toContain('requests10');
    expect(w.events.filter((e) => e.type === 'news' && e.text.includes('実績')).length).toBe(1);
    w.events = [];
    companyMonthly(w);
    expect(w.events.filter((e) => e.type === 'news' && e.text.includes('実績')).length).toBe(0);
  });

  it('実績のIDは重ならない', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });

  it('ランク・実績・数えはセーブに残り、前の版のセーブ（なし）も読める', () => {
    const w = generateWorld(8);
    w.requestState.nextCheckDay = 1e9;
    step(w, 40 * TICKS_PER_DAY);
    w.rank = 2;
    w.achievements = { first_train: 10 };
    w.stats = { boomTons: 50 };
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.rank).toBe(2);
    expect(w2.achievements).toEqual({ first_train: 10 });
    expect(w2.stats!.boomTons).toBe(50);
    const f = JSON.parse(serializeWorld(w));
    delete f.world.rank;
    delete f.world.achievements;
    delete f.world.stats;
    const w3 = deserializeWorld(JSON.stringify(f));
    expect(w3.rank).toBe(0);
  });
});
