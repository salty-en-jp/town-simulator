// チャレンジモード（v0.6）
//
// ・はっきりしたミッションと期限のある、短めのステージ。失敗はない（期限までの達成度で★0〜3）
// ・決まったステージ（8つ）、今日のステージ（日付で決まる）、ランダムステージ（何度でも）
// ・ミッションは「何を測るか（metric）」と「★1・★2・★3 の目標」と「期限（年）」と「しばり（rules）」でできている
// ・ランダムでも同じ数（seed）なら、いつでも同じマップとミッションになる

import { companyValue } from './company';
import { generateWorld } from './mapgen';
import { Rng } from './rng';
import { isEngine, type VehicleType } from './constants';
import { dateOf, type World } from './world';

export type MetricId =
  | 'lumber'
  | 'food'
  | 'materials'
  | 'pax'
  | 'paxIncome'
  | 'totalPop'
  | 'biggestTown'
  | 'steel'
  | 'value'
  | 'income'
  | 'towns';

export interface Metric {
  label: string;
  unit: string;
  /** 目標の文（{n} に数が入る） */
  goal: string;
  value: (w: World) => number;
}

const townTotal = (w: World, c: 'lumber' | 'food' | 'materials' | 'passengers') => [...w.towns.values()].reduce((n, t) => n + (t.recv[c]?.total ?? 0), 0);

export const METRICS: Record<MetricId, Metric> = {
  lumber: { label: '町に届けた木材', unit: 't', goal: '木材を町に{n}届ける', value: (w) => townTotal(w, 'lumber') },
  food: { label: '町に届けた食料品', unit: 't', goal: '食料品を町に{n}届ける', value: (w) => townTotal(w, 'food') },
  materials: { label: '町に届けた建設資材', unit: 't', goal: '建設資材を町に{n}届ける', value: (w) => townTotal(w, 'materials') },
  pax: { label: '運んだ旅客', unit: '人', goal: '旅客を{n}運ぶ', value: (w) => townTotal(w, 'passengers') },
  paxIncome: { label: '旅客の運賃', unit: '円', goal: '旅客の運賃で{n}稼ぐ', value: (w) => w.stats?.paxIncome ?? 0 },
  totalPop: { label: '町の人口の合計', unit: '人', goal: '町の人口の合計を{n}にする', value: (w) => [...w.towns.values()].reduce((n, t) => n + t.population, 0) },
  biggestTown: { label: 'いちばん大きな町の人口', unit: '人', goal: '1つの町の人口を{n}にする', value: (w) => Math.max(0, ...[...w.towns.values()].map((t) => t.population)) },
  steel: {
    label: '製鉄所から運び出した鋼材',
    unit: 't',
    goal: '製鉄所の鋼材を{n}運び出す',
    value: (w) => [...w.industries.values()].filter((i) => i.type === 'steelmill').reduce((n, i) => n + i.transportedTotal, 0),
  },
  value: { label: '会社の価値', unit: '円', goal: '会社の価値を{n}にする', value: (w) => companyValue(w) },
  income: { label: '運賃収入の合計', unit: '円', goal: '運賃で合わせて{n}稼ぐ', value: (w) => w.requestState.incomeTotal ?? 0 },
  towns: { label: '駅でつないだ町', unit: 'つ', goal: '{n}の町に、使われている駅をつくる', value: (w) => [...w.towns.values()].filter((t) => t.activeStations > 0).length },
};

export type Rule = 'noLoan' | 'steamOnly' | 'smallBudget';

export const RULE_TEXT: Record<Rule, string> = {
  noLoan: '借入なし',
  steamOnly: 'ツナグ形（蒸気機関車）だけ',
  smallBudget: '少ない元手（3,000万円）',
};

export interface ChallengeDef {
  kind: 'stage' | 'daily' | 'random';
  /** 記録のための名前（決まったステージは stage-1 など、今日は daily-20261110、ランダムは random） */
  id: string;
  title: string;
  /** ひとこと説明 */
  lead: string;
  seed: number;
  metric: MetricId;
  /** ★1・★2・★3 の目標 */
  goals: [number, number, number];
  years: number;
  rules: Rule[];
}

/** 遊んでいるチャレンジ（世界に保存する） */
export interface ChallengeState extends ChallengeDef {
  startDay: number;
  endDay: number;
  /** 期限が来た（結果を出した） */
  done?: boolean;
}

export const STAGES: ChallengeDef[] = [
  { kind: 'stage', id: 'stage-1', title: 'はじめての木材', lead: '森から製材所へ、製材所から町へ。まずは木材の流れをつくろう', seed: 1101, metric: 'lumber', goals: [60, 150, 300], years: 2, rules: [] },
  { kind: 'stage', id: 'stage-2', title: 'ふたつの町', lead: '町と町を線路で結んで、人を運ぼう', seed: 1102, metric: 'pax', goals: [500, 1500, 3000], years: 3, rules: [] },
  { kind: 'stage', id: 'stage-3', title: '食卓をささえる', lead: '農場の穀物を食品工場へ。できた食料品を町へ', seed: 1103, metric: 'food', goals: [80, 250, 500], years: 3, rules: [] },
  { kind: 'stage', id: 'stage-4', title: '町を育てる', lead: '木材と食料品で、町を大きくしよう', seed: 1104, metric: 'totalPop', goals: [1500, 2500, 4000], years: 4, rules: [] },
  { kind: 'stage', id: 'stage-5', title: '小さな予算', lead: '借りずに、少ない元手からやりくりしよう', seed: 1105, metric: 'value', goals: [60_000_000, 120_000_000, 250_000_000], years: 5, rules: ['noLoan', 'smallBudget'] },
  { kind: 'stage', id: 'stage-6', title: '鉄の道', lead: '鉄鉱石と石炭を製鉄所へ。鋼材を運び出そう', seed: 1106, metric: 'steel', goals: [100, 300, 700], years: 4, rules: [] },
  { kind: 'stage', id: 'stage-7', title: '蒸気の時代', lead: 'ツナグ形だけで、たくさんの町をつなごう', seed: 1107, metric: 'towns', goals: [2, 3, 4], years: 3, rules: ['steamOnly'] },
  { kind: 'stage', id: 'stage-8', title: '都市へ', lead: 'ひとつの町を、都市（5,000人）まで育てよう', seed: 1108, metric: 'biggestTown', goals: [2000, 3500, 5000], years: 8, rules: [] },
];

// ───────────────────────── 今日のステージ・ランダムステージ ─────────────────────────

interface Template {
  metric: MetricId;
  title: string;
  lead: string;
  /** 1年あたりの★3 の目安（ここから★1・★2 を決める） */
  perYear: number;
  years: [number, number];
  round: number;
}

const TEMPLATES: Template[] = [
  { metric: 'lumber', title: '木の町づくり', lead: '木材をどんどん町へ', perYear: 150, years: [2, 4], round: 10 },
  { metric: 'food', title: 'おなかいっぱい', lead: '食料品を町へ届けよう', perYear: 160, years: [2, 4], round: 10 },
  { metric: 'pax', title: '人の行き来', lead: '町と町をつないで旅客を運ぼう', perYear: 1000, years: [2, 4], round: 100 },
  { metric: 'totalPop', title: 'にぎやかな地方', lead: '町の人口を増やそう', perYear: 900, years: [3, 5], round: 100 },
  { metric: 'income', title: '稼ぐ鉄道', lead: '運賃でたくさん稼ごう', perYear: 40_000_000, years: [2, 4], round: 5_000_000 },
  { metric: 'value', title: 'よい会社', lead: '会社の価値を上げよう', perYear: 40_000_000, years: [3, 5], round: 10_000_000 },
  { metric: 'steel', title: '鉄をつくる', lead: '製鉄所を動かそう', perYear: 160, years: [3, 5], round: 10 },
  { metric: 'towns', title: 'みんなをつなぐ', lead: 'たくさんの町に駅をつくろう', perYear: 1, years: [2, 4], round: 1 },
];

/** 数（seed）からステージを作る。同じ数なら同じステージ */
export function makeGenerated(seed: number, kind: 'daily' | 'random', id: string, titlePrefix: string): ChallengeDef {
  const r = new Rng(seed);
  const t = r.pick(TEMPLATES);
  const years = r.int(t.years[0], t.years[1]);
  const rules: Rule[] = [];
  if (t.metric !== 'value' && r.chance(0.25)) rules.push('noLoan');
  if (r.chance(0.2)) rules.push('steamOnly');
  const top = t.metric === 'towns' ? Math.min(4, 1 + years) : t.perYear * years * (rules.length ? 0.8 : 1);
  const q = (v: number) => Math.max(t.round, Math.round(v / t.round) * t.round);
  const goals: [number, number, number] = t.metric === 'towns' ? [Math.max(1, top - 2), Math.max(2, top - 1), top] : [q(top * 0.3), q(top * 0.6), q(top)];
  return { kind, id, title: `${titlePrefix}${t.title}`, lead: t.lead, seed: (seed % 900_000_000) + 1, metric: t.metric, goals, years, rules };
}

/** 今日のステージ（端末の日付で決まる。家族みんな同じ日に同じステージ） */
export function dailyChallenge(now = new Date()): ChallengeDef {
  const key = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  return makeGenerated(key * 7919, 'daily', `daily-${key}`, `今日のステージ：`);
}

export function randomChallenge(seed = Math.floor(Math.random() * 1e9)): ChallengeDef {
  return makeGenerated(seed, 'random', 'random', 'ランダム：');
}

// ───────────────────────── 始める・進み具合 ─────────────────────────

/** チャレンジ用の世界をつくる */
export function createChallengeWorld(def: ChallengeDef): World {
  const w = generateWorld(def.seed);
  if (def.rules.includes('smallBudget')) w.money = 30_000_000;
  if (def.rules.includes('noLoan')) {
    w.money = Math.max(0, w.money - w.loan);
    if (def.rules.includes('smallBudget')) w.money = 30_000_000;
    w.loan = 0;
    w.maxLoan = 0;
  }
  // 依頼ボードは、ミッションに集中できるよう、しばらく出さない
  w.requestState.nextCheckDay = 1e9;
  w.challenge = { ...def, startDay: w.day, endDay: w.day + Math.round(def.years * 365) };
  return w;
}

export function starsFor(def: { goals: [number, number, number] }, value: number): 0 | 1 | 2 | 3 {
  return value >= def.goals[2] ? 3 : value >= def.goals[1] ? 2 : value >= def.goals[0] ? 1 : 0;
}

export interface Progress {
  value: number;
  stars: 0 | 1 | 2 | 3;
  /** 次の★の目標（★3 なら null） */
  next: number | null;
  daysLeft: number;
}

export function challengeProgress(world: World): Progress | null {
  const c = world.challenge;
  if (!c) return null;
  const value = METRICS[c.metric].value(world);
  const stars = starsFor(c, value);
  return { value, stars, next: stars < 3 ? c.goals[stars as 0 | 1 | 2] : null, daysLeft: Math.max(0, c.endDay - world.day) };
}

/** 期限が来たか（来たら done にして true を返す。1回だけ） */
export function checkChallengeEnd(world: World): boolean {
  const c = world.challenge;
  if (!c || c.done || world.day < c.endDay) return false;
  c.done = true;
  return true;
}

export function goalText(c: { metric: MetricId }, n: number): string {
  return METRICS[c.metric].goal.replace('{n}', formatAmount(c.metric, n));
}

export function formatAmount(metric: MetricId, n: number): string {
  const unit = METRICS[metric].unit;
  if (unit === '円') {
    if (Math.abs(n) >= 100_000_000) return `${Math.round((n / 100_000_000) * 10) / 10}億円`;
    return `${Math.round(n / 10_000).toLocaleString('ja-JP')}万円`;
  }
  return `${Math.round(n).toLocaleString('ja-JP')}${unit}`;
}

// ───────────────────────── しばり ─────────────────────────

export function rulesOf(world: World): Rule[] {
  return world.challenge?.rules ?? [];
}

/** しばりで買えない車両か（だめなら理由） */
export function ruleBlocksVehicle(world: World, type: VehicleType): string | null {
  if (rulesOf(world).includes('steamOnly') && isEngine(type) && type !== 'steam') return 'このステージはツナグ形だけです';
  return null;
}

export function ruleBlocksBorrow(world: World): string | null {
  return rulesOf(world).includes('noLoan') ? 'このステージは借入なしです' : null;
}

/** ステージの開始年 */
export function startYear(world: World): number {
  return dateOf(world.challenge?.startDay ?? world.day).y;
}
