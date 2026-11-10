// 会社のランクと実績（v0.5.12）
//
// ・ランク：会社の価値（お金 − 借入 ＋ 車両 ＋ 自社の産業）と、つないだ町の人口で決まる。上がるだけ
// ・ランクが上がると、借入の上限が上がる（ごほうび）
// ・実績：遊んでいるうちに自然に目指せる「おまけの目標」。毎月たしかめる
// 方針：失敗も罰もない。やり込みたい人のための目印

import { CARGOS, ENGINE_SPECS, FINANCE, INDUSTRY_SPECS, isEngine, WAGON_SPECS, type Cargo } from './constants';
import { stageForPop } from './towns';
import { dateOf, industryValue, pushEvent, type World } from './world';
import { vehicleAssets } from './simulate';

export interface Rank {
  name: string;
  /** 会社の価値（円） */
  value: number;
  /** 駅でつないでいる町の人口の合計 */
  pop: number;
  /** このランクでの借入の上限 */
  maxLoan: number;
}

export const RANKS: Rank[] = [
  { name: '村の鉄道', value: -Infinity, pop: 0, maxLoan: FINANCE.maxLoan },
  { name: '町の鉄道', value: 100_000_000, pop: 1_000, maxLoan: 150_000_000 },
  { name: '地方鉄道', value: 300_000_000, pop: 3_000, maxLoan: 250_000_000 },
  { name: '中堅私鉄', value: 1_000_000_000, pop: 8_000, maxLoan: 400_000_000 },
  { name: '大手私鉄', value: 3_000_000_000, pop: 20_000, maxLoan: 700_000_000 },
  { name: '日本を結ぶ鉄道', value: 10_000_000_000, pop: 50_000, maxLoan: 1_000_000_000 },
];

/** 会社の価値：お金 − 借入 ＋ 車両の価値 ＋ 自社の産業の価値 */
export function companyValue(world: World): number {
  let v = world.money - world.loan + vehicleAssets(world);
  for (const ind of world.industries.values()) if (ind.owner === 'player') v += industryValue(ind);
  return Math.round(v);
}

/** 駅でつないでいる（使われている駅がある）町の人口の合計 */
export function connectedPopulation(world: World): number {
  let p = 0;
  for (const t of world.towns.values()) if (t.activeStations > 0) p += t.population;
  return p;
}

export function rankIndex(world: World): number {
  return world.rank ?? 0;
}

/** 今の数字で届いているランク（上がるだけなので、保存してある方と大きい方を使う） */
export function rankFor(value: number, pop: number): number {
  let r = 0;
  for (let i = 1; i < RANKS.length; i++) if (value >= RANKS[i].value && pop >= RANKS[i].pop) r = i;
  return r;
}

// ───────────────────────── 実績 ─────────────────────────

export interface Achievement {
  id: string;
  name: string;
  /** まだのときに出すヒント */
  hint: string;
  check: (w: World) => boolean;
}

const towns = (w: World) => [...w.towns.values()];
const inds = (w: World) => [...w.industries.values()];
const delivered = (w: World, c: Cargo) => towns(w).some((t) => (t.recv[c]?.total ?? 0) > 0);
const allCars = (w: World) => [...[...w.trains.values()].flatMap((t) => t.cars), ...[...w.depots.values()].flatMap((d) => d.stored)];

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_train', name: 'はじめての発車', hint: '列車を走らせる', check: (w) => [...w.trains.values()].some((t) => t.state !== 'in_depot') },
  { id: 'first_income', name: 'はじめての運賃', hint: '荷物か旅客を届けて運賃を受け取る', check: (w) => (w.requestState.incomeTotal ?? 0) > 0 },
  { id: 'lumber_house', name: '木の家', hint: '木材を町に届ける', check: (w) => delivered(w, 'lumber') },
  { id: 'food', name: 'いただきます', hint: '食料品を町に届ける', check: (w) => delivered(w, 'food') },
  { id: 'steel', name: '鉄の道', hint: '製鉄所で鋼材をつくる（鉄鉱石と石炭の両方を届ける）', check: (w) => inds(w).some((i) => i.type === 'steelmill' && i.producedLastMonth + i.producedThisMonth > 0) },
  { id: 'tower', name: 'はじめての高層ビル', hint: '建設資材を町に届けて、ビルを建てる', check: (w) => w.occ.some((o) => o?.k === 'house' && o.level === 3) },
  { id: 'town', name: '村から町へ', hint: '町の人口を1,000人にする', check: (w) => towns(w).some((t) => stageForPop(t.population) >= 1 || (t.stage ?? 0) >= 1) },
  { id: 'city', name: '都市の誕生', hint: '町の人口を5,000人にする', check: (w) => towns(w).some((t) => (t.stage ?? 0) >= 2) },
  { id: 'metropolis', name: '大都市', hint: '1つの町の人口を1万人にする', check: (w) => towns(w).some((t) => t.population >= 10_000) },
  { id: 'pop30k', name: '人口3万人の地域', hint: '町の人口の合計を3万人にする', check: (w) => towns(w).reduce((n, t) => n + t.population, 0) >= 30_000 },
  { id: 'all_towns', name: 'みんなつながった', hint: 'すべての町に、使われている駅をつくる', check: (w) => towns(w).length > 0 && towns(w).every((t) => t.activeStations > 0) },
  {
    id: 'all_industries',
    name: '産業博士',
    hint: 'このマップにあるすべての種類の産業から運び出すか、届ける',
    // このマップにある種類だけ（海のないマップに漁港はない）
    check: (w) => [...new Set(inds(w).map((i) => i.type))].every((type) => inds(w).some((i) => i.type === type && i.transportedTotal + i.receivedTotal > 0)),
  },
  {
    id: 'all_cargo',
    name: 'なんでも運ぶ',
    hint: 'このマップでとれる、すべての種類の貨物を運ぶ',
    check: (w) => {
      const made = new Set<Cargo>(inds(w).map((i) => INDUSTRY_SPECS[i.type].output));
      return CARGOS.filter((c) => c === 'passengers' || made.has(c)).every((c) =>
        c === 'passengers' ? towns(w).some((t) => (t.recv.passengers?.total ?? 0) > 0) : (w.stats?.cargo?.[c] ?? 0) > 0,
      );
    },
  },
  { id: 'owner', name: 'オーナー', hint: '自社の産業を持つ（権利を買う・探鉱・工場の建設）', check: (w) => inds(w).some((i) => i.owner === 'player') },
  { id: 'owner5', name: '産業グループ', hint: '自社の産業を5つ持つ', check: (w) => inds(w).filter((i) => i.owner === 'player').length >= 5 },
  { id: 'contract', name: '契約成立', hint: '他社の産業と輸送契約を結ぶ', check: (w) => inds(w).some((i) => i.contractFrom > 0 || i.contractUntil > 0) },
  { id: 'requests10', name: '頼れる鉄道', hint: '依頼を10件達成する', check: (w) => w.requestState.completed >= 10 },
  { id: 'boom', name: '波に乗る', hint: 'ブームの場所に荷物を届ける（合わせて100t）', check: (w) => (w.stats?.boomTons ?? 0) >= 100 },
  { id: 'intercity', name: '都市と都市を結ぶ', hint: '大きな町どうしで旅客を運ぶ（合わせて1,000人）', check: (w) => (w.stats?.intercityPax ?? 0) >= 1000 },
  { id: 'income100m', name: '年収1億円', hint: '1年の運賃収入を1億円にする', check: (w) => w.finance.lastYear.income >= 100_000_000 },
  { id: 'no_debt', name: '借金ゼロ', hint: '借入金を全部返す', check: (w) => w.loan === 0 && w.day > 30 },
  { id: 'trains20', name: '大きな車庫', hint: '列車を20本走らせる', check: (w) => w.trains.size >= 20 },
  {
    id: 'new_model',
    name: '新しもの好き',
    hint: '年代で登場した新型車両を使う',
    check: (w) => allCars(w).some((c) => (isEngine(c.type) ? ENGINE_SPECS[c.type].year : WAGON_SPECS[c.type].year) !== undefined),
  },
  { id: 'devel', name: 'わが社の機関車', hint: '自社開発の機関車を完成させる', check: (w) => (w.designs ?? []).some((d) => d.done !== undefined) },
  { id: 'sale', name: '車両メーカー', hint: '自社開発の機関車を、ほかの鉄道会社に売る', check: (w) => (w.designs ?? []).some((d) => (d.sale?.sold ?? 0) > 0) },
  { id: 'parts5', name: '技術の会社', hint: '部品を5つ研究する', check: (w) => (w.parts?.length ?? 0) >= 5 },
  { id: 'award', name: '鉄道車両大賞', hint: '鉄道車両大賞をとる', check: (w) => (w.awards ?? []).some((a) => a.mine) },
  { id: 'super', name: '夢の超特急', hint: 'フェアリィ形ディーゼル超特急を走らせる', check: (w) => [...w.trains.values()].some((t) => t.cars[0]?.type === 'superexpress' && t.state !== 'in_depot') },
];

/** 毎月：ランクと実績をたしかめて、上がった・取れたらお知らせ */
export function companyMonthly(world: World) {
  const value = companyValue(world);
  const pop = connectedPopulation(world);
  const want = rankFor(value, pop);
  if (want > rankIndex(world)) {
    world.rank = want;
    const r = RANKS[want];
    world.maxLoan = Math.max(world.maxLoan, r.maxLoan);
    pushEvent(world, {
      type: 'news',
      text: `会社のランクが「${r.name}」になりました！ 借入の上限が${Math.round(r.maxLoan / 1e8 * 10) / 10}億円になります`,
      tone: 'good',
    });
  }
  world.achievements ??= {};
  const got: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (world.achievements[a.id] !== undefined) continue;
    if (!a.check(world)) continue;
    world.achievements[a.id] = world.day;
    got.push(a);
  }
  // 前の版のセーブなどで一度にたくさん取れたときは、お知らせを1つにまとめる
  if (got.length > 3) pushEvent(world, { type: 'news', text: `実績を${got.length}個達成しました！（会社のウィンドウで見られます）`, tone: 'good' });
  else for (const a of got) pushEvent(world, { type: 'news', text: `実績「${a.name}」を達成しました！`, tone: 'good' });
}

/** 実績の達成日（ゲームの中の日付）を文字に */
export function achievedLabel(day: number): string {
  const d = dateOf(day);
  return `${d.y}年${d.m}月`;
}
