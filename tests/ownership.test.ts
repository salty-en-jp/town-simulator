import { describe, expect, it } from 'vitest';
import { addOrder, buildDepot, buildStation, buildTrack, buyTrain, startStop } from '../src/sim/commands';
import { INDUSTRY_ECON, TICKS_PER_DAY } from '../src/sim/constants';
import {
  addIndustry,
  buildFactory,
  buyRights,
  canPlaceIndustry,
  expandIndustry,
  signContract,
  startSurvey,
} from '../src/sim/industries';
import { generateWorld } from '../src/sim/mapgen';
import { deserializeWorld, serializeWorld } from '../src/sim/save';
import { acceptors, step } from '../src/sim/simulate';
import { canLoadFrom, createEmptyWorld, idx, type World } from '../src/sim/world';

const days = (w: World, n: number) => step(w, n * TICKS_PER_DAY);

/** 他社の森 → 製材所の路線 */
function otherForest() {
  const w = createEmptyWorld(48, 16, 6);
  w.money = 2_000_000_000;
  const forest = addIndustry(w, 'forest', '他社の森', 2, 2, 3, 3, 'other');
  const saw = addIndustry(w, 'sawmill', '製材所', 30, 2, 3, 2, 'public');
  buildTrack(w, idx(w, 1, 7), idx(w, 40, 7));
  const s1 = buildStation(w, idx(w, 3, 7), idx(w, 5, 7)).id!;
  const s2 = buildStation(w, idx(w, 30, 7), idx(w, 32, 7)).id!;
  const depot = buildDepot(w, idx(w, 8, 8)).id!;
  const tr = buyTrain(w, depot, ['logcar', 'logcar']).id!;
  addOrder(w, tr, s1);
  addOrder(w, tr, s2);
  w.requestState.nextCheckDay = 1e9;
  return { w, forest, saw, s1, s2, tr };
}

describe('他社の産業', () => {
  it('権利も契約もないと、駅に貨物が来ない', () => {
    const { w, forest, s1, tr } = otherForest();
    startStop(w, tr);
    days(w, 60);
    expect(canLoadFrom(w, forest)).toBe(false);
    expect(w.stations.get(s1)!.goods.logs.waiting).toBe(0);
    expect(forest.transportedTotal).toBe(0);
  });

  it('輸送契約を結ぶと運べる。期限が切れるとまた運べなくなる', () => {
    const { w, forest, tr } = otherForest();
    expect(signContract(w, forest.id).ok).toBe(true);
    startStop(w, tr);
    days(w, 90);
    expect(forest.transportedTotal).toBeGreaterThan(0);
    expect(canLoadFrom(w, forest)).toBe(true);
    // 期限を過ぎる
    forest.contractUntil = w.day + 1;
    days(w, 40);
    expect(canLoadFrom(w, forest)).toBe(false);
  });

  it('運び出しが少ないと契約が打ち切られる', () => {
    const { w, forest } = otherForest();
    signContract(w, forest.id);
    // 列車を走らせない → 輸送率0%
    days(w, 30 * 6);
    expect(forest.contractUntil).toBe(0);
    expect(w.events.some((e) => e.type === 'news' && e.text.includes('打ち切られました'))).toBe(true);
  });

  it('権利を買うと自社になり、運んだ分の配当が入り、維持費がかかる。増産もできる', () => {
    const { w, forest, tr } = otherForest();
    const price = buyRights(w, forest.id, { dry: true }).cost;
    const m0 = w.money;
    expect(buyRights(w, forest.id).ok).toBe(true);
    expect(w.money).toBe(m0 - price);
    expect(forest.owner).toBe('player');
    startStop(w, tr);
    days(w, 120);
    expect(w.finance.thisYear.dividends + w.finance.lastYear.dividends).toBeGreaterThan(0);
    expect(w.finance.thisYear.facilities + w.finance.lastYear.facilities).toBeLessThan(0);
    const rate = forest.prodRate;
    expect(expandIndustry(w, forest.id).ok).toBe(true);
    expect(forest.prodRate).toBe(Math.round(rate * INDUSTRY_ECON.expandFactor));
  });

  it('地元の産業は契約なしで運べ、権利を買えば自社になる', () => {
    const { w, saw } = otherForest();
    expect(canLoadFrom(w, saw)).toBe(true);
    expect(signContract(w, saw.id).ok).toBe(false);
    expect(buyRights(w, saw.id).ok).toBe(true);
    expect(saw.owner).toBe('player');
  });
});

describe('探鉱', () => {
  it('成功すると調査期間のあと自社の産業ができ、失敗すると何もできない', () => {
    const w = createEmptyWorld(40, 40, 8);
    w.money = 1e9;
    const ok = startSurvey(w, 'coalmine', 5, 5);
    const ng = startSurvey(w, 'ironmine', 25, 25);
    expect(ok.ok && ng.ok).toBe(true);
    w.surveys[0].roll = 0; // 必ず成功
    w.surveys[1].roll = 0.999; // 必ず失敗
    // 数えるのは自社の産業だけ（自然に見つかる他社の産業や、町ごとの名産の工房は数えない）
    const count = () => [...w.industries.values()].filter((i) => i.owner === 'player').length;
    const n0 = count();
    days(w, INDUSTRY_ECON.surveyDays - 5);
    expect(count()).toBe(n0);
    days(w, 10);
    expect(count()).toBe(n0 + 1);
    const mine = [...w.industries.values()].find((i) => i.type === 'coalmine')!;
    expect(mine.owner).toBe('player');
    expect([...w.industries.values()].some((i) => i.type === 'ironmine' && i.owner === 'player')).toBe(false);
    expect(w.surveys.length).toBe(0);
  });

  it('費用は先に払う。水の近くや建物の上ではできない', () => {
    const w = createEmptyWorld(40, 40, 8);
    const m0 = w.money;
    startSurvey(w, 'forest', 5, 5);
    expect(w.money).toBe(m0 - INDUSTRY_ECON.surveyCost.forest);
    w.terrain[idx(w, 21, 20)] = 1;
    expect(startSurvey(w, 'farm', 20, 20).ok).toBe(false);
    expect(canPlaceIndustry(w, 'forest', 5, 5, false)).toMatch(/調査中/);
  });
});

describe('工場の建設', () => {
  it('建設中は動かず受け入れもしない。完成すると動き出す', () => {
    const w = createEmptyWorld(40, 20, 9);
    w.money = 1e9;
    const r = buildFactory(w, 'sawmill', 10, 4);
    expect(r.ok).toBe(true);
    const ind = w.industries.get(r.id!)!;
    expect(ind.owner).toBe('player');
    expect(ind.status).toBe('building');
    buildTrack(w, idx(w, 5, 8), idx(w, 20, 8));
    const st = buildStation(w, idx(w, 10, 8), idx(w, 12, 8)).id!;
    expect(acceptors(w, w.stations.get(st)!, 'logs').length).toBe(0);
    days(w, INDUSTRY_ECON.buildDays + 1);
    expect(ind.status).toBe('active');
    expect(acceptors(w, w.stations.get(st)!, 'logs').length).toBe(1);
  });
});

describe('マップと自然発見', () => {
  it('はじめから使えるのは各種類1つずつ、2つめからは他社', () => {
    const w = generateWorld(11);
    const byType = new Map<string, string[]>();
    // 名産の工房は町ごとに1つずつで、どれも地元の産業
    for (const i of w.industries.values()) if (i.type !== 'workshop') byType.set(i.type, [...(byType.get(i.type) ?? []), i.owner]);
    expect([...w.industries.values()].filter((i) => i.type === 'workshop').every((i) => i.owner === 'public')).toBe(true);
    for (const owners of byType.values()) {
      expect(owners[0]).toBe('public');
      expect(owners.slice(1).every((o) => o === 'other')).toBe(true);
    }
  });

  it('何年か経つと他社の一次産業が見つかる', () => {
    const w = generateWorld(12);
    const n0 = w.industries.size;
    days(w, 365 * 6);
    expect(w.industries.size).toBeGreaterThan(n0);
    const added = [...w.industries.values()].slice(n0);
    expect(added.every((i) => i.owner === 'other')).toBe(true);
  });

  it('探鉱中・建設中でもセーブして読み込める', () => {
    const w = generateWorld(13);
    w.money = 1e9;
    for (let y = 5; y < 90 && w.surveys.length === 0; y += 7) for (let x = 5; x < 90 && w.surveys.length === 0; x += 7) startSurvey(w, 'farm', x, y);
    expect(w.surveys.length).toBe(1);
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.surveys.length).toBe(1);
    expect(w2.surveys[0].roll).toBe(w.surveys[0].roll);
  });
});
