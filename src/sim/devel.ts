// 機関車の自社開発（v0.8.2）
//
// ・動力（蒸気・ディーゼル・電気）と用途（通勤・特急・貨物・山岳・観光）を選び、予算を決めて開発をはじめる
// ・開発中は毎日「速さ・力・経済性・快適さ」のポイントがたまる。たまり方は用途と動力で決まる
// ・30%で「試運転」、70%で「高速試験」。方針（堅実・挑戦・大胆）を選ぶ。うまくいけばポイントが増え、
//   大胆に失敗すると「初期不良」（維持費が高い・評価が下がる。あとでお金を払って改修できる）
// ・動力と用途には相性がある（表は隠してあり、つくってみると図鑑の相性表に記録される）
// ・できあがった機関車は車庫で買える。評価（★1〜5）で「鉄道ファンの評判」が上下する
// 方針：手をかけた人がもっと得をする形にする。失敗しても、持ち物に損害は出さない（開発費が無駄になるだけ）

import {
  DEV_POWER_NAMES,
  DEV_USE_NAMES,
  ENGINE_SPECS,
  ENGINE_TYPES,
  clearDevEngines,
  registerDevEngine,
  type DevEngineType,
  type DevPower,
  type DevUse,
  type EngineSpec,
  type EngineType,
} from './constants';
import { ELECTRIFY_YEAR, dateOf, pushEvent, spend, type World } from './world';

export type TestChoice = 'safe' | 'bold' | 'daring';
export type DevStat = 'speed' | 'might' | 'economy' | 'comfort';
export const DEV_STATS: DevStat[] = ['speed', 'might', 'economy', 'comfort'];
export const DEV_STAT_NAMES: Record<DevStat, string> = { speed: '速さ', might: '力', economy: '経済性', comfort: '快適さ' };

export interface TestResult {
  choice: TestChoice;
  ok: boolean;
}

export interface Design {
  id: number;
  name: string;
  power: DevPower;
  use: DevUse;
  /** 予算の段階（0：試作・1：本格・2：社運をかけた） */
  budget: number;
  color: number;
  /** はじめた日 */
  start: number;
  /** 開発にかかる日数と、進んだ日数 */
  days: number;
  progress: number;
  pts: Record<DevStat, number>;
  /** 試運転（30%）・高速試験（70%）の結果 */
  tests: TestResult[];
  /** 試験の方針を待っているとき（開発は止まる） */
  waiting?: boolean;
  defect?: boolean;
  /** できあがった日 */
  done?: number;
  /** 評価（★1〜5） */
  rating?: number;
}

export const DEV = {
  maxDesigns: 24,
  budgets: [
    { name: '試作', cost: 15_000_000, days: 100, pool: 100 },
    { name: '本格', cost: 40_000_000, days: 160, pool: 180 },
    { name: '社運をかけた', cost: 100_000_000, days: 240, pool: 280 },
  ],
  /** 試験の時期（進み具合） */
  tests: [0.3, 0.7],
  testNames: ['試運転', '高速試験'],
  /** 試験ごとに伸びる能力（試運転は力と経済性、高速試験は速さと快適さ） */
  testStats: [
    ['might', 'economy'],
    ['speed', 'comfort'],
  ] as DevStat[][],
  choices: {
    safe: { name: '堅実', chance: 0.9, bonus: 0.08 },
    bold: { name: '挑戦', chance: 0.65, bonus: 0.2 },
    daring: { name: '大胆', chance: 0.4, bonus: 0.4 },
  } as Record<TestChoice, { name: string; chance: number; bonus: number }>,
  /** 挑戦に失敗したときに減るポイントの割合 */
  setback: 0.05,
  /** 初期不良：維持費の倍率と、改修の費用（開発費に対する割合） */
  defectRunning: 1.3,
  fixCostRate: 0.25,
  colors: [0x2f6f8f, 0x8f2f3a, 0x2f7a4a, 0xd08a2a, 0x6a4a8a, 0x3a3f48, 0xd8d2c0],
};

/** 動力と用途の相性（隠しパラメータ。つくってみると図鑑の相性表に記録される） */
const COMPAT: Record<DevPower, Record<DevUse, number>> = {
  steam: { commuter: 0.8, express: 0.75, freight: 1.0, mountain: 1.1, tourist: 1.4 },
  diesel: { commuter: 1.0, express: 1.0, freight: 1.3, mountain: 1.2, tourist: 0.9 },
  electric: { commuter: 1.4, express: 1.3, freight: 1.0, mountain: 0.85, tourist: 0.8 },
};

export function compat(power: DevPower, use: DevUse): number {
  return COMPAT[power][use];
}

/** 相性の記号：◎ 抜群・○ ふつう・△ いまひとつ */
export function compatMark(power: DevPower, use: DevUse): '◎' | '○' | '△' {
  const c = compat(power, use);
  return c >= 1.3 ? '◎' : c >= 1 ? '○' : '△';
}

/** 用途ごとの、ポイントのたまり方（速さ・力・経済性・快適さ） */
const USE_WEIGHTS: Record<DevUse, number[]> = {
  commuter: [0.2, 0.25, 0.3, 0.25],
  express: [0.45, 0.15, 0.1, 0.3],
  freight: [0.15, 0.5, 0.3, 0.05],
  mountain: [0.2, 0.45, 0.25, 0.1],
  tourist: [0.15, 0.15, 0.2, 0.5],
};
/** 動力ごとのくせ（蒸気は力と快適さ、電気は速さと経済性） */
const POWER_WEIGHTS: Record<DevPower, number[]> = {
  steam: [0.85, 1.15, 0.8, 1.15],
  diesel: [1, 1.1, 1, 0.95],
  electric: [1.15, 1, 1.15, 1],
};
const POWER_SPEED: Record<DevPower, number> = { steam: 3.6, diesel: 4.2, electric: 4.8 };
const USE_SPEED: Record<DevUse, number> = { commuter: 0, express: 0.8, freight: -0.5, mountain: -0.3, tourist: -0.4 };
const USE_CARS: Record<DevUse, number> = { commuter: 6, express: 6, freight: 8, mountain: 6, tourist: 4 };
const POWER_RUNNING: Record<DevPower, number> = { steam: 2_000_000, diesel: 1_800_000, electric: 1_300_000 };
const USE_ALLOW: Record<DevUse, EngineSpec['allow']> = { commuter: 'pax', express: 'pax', freight: 'freight', mountain: 'any', tourist: 'pax' };

function weights(power: DevPower, use: DevUse): number[] {
  const w = USE_WEIGHTS[use].map((v, i) => v * POWER_WEIGHTS[power][i]);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

export const devKey = (d: Design): DevEngineType => `dev${d.id}`;

export function designOf(world: World, t: EngineType | string): Design | undefined {
  const m = /^dev(\d+)$/.exec(t);
  if (!m) return undefined;
  const id = Number(m[1]);
  return world.designs?.find((d) => d.id === id);
}

export function devPowerOk(world: World, power: DevPower): boolean {
  return power !== 'electric' || dateOf(world.day).y >= ELECTRIFY_YEAR;
}

/** できあがった機関車の能力 */
export function designSpec(d: Design): EngineSpec {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const speed = r1(Math.min(10, Math.max(2.5, POWER_SPEED[d.power] + USE_SPEED[d.use] + d.pts.speed * 0.018)));
  const maxCars = Math.min(16, USE_CARS[d.use] + Math.floor(d.pts.might * 0.04));
  const running = POWER_RUNNING[d.power] * Math.max(0.45, 1 - d.pts.economy * 0.006) * (d.defect ? DEV.defectRunning : 1);
  const comfort = 1 + Math.min(0.5, d.pts.comfort * 0.003 * (d.use === 'tourist' ? 1.5 : 1));
  const cost = Math.round((4_000_000 + speed * speed * 400_000 + maxCars * 600_000) / 100_000) * 100_000;
  const allow = USE_ALLOW[d.use];
  return {
    name: d.name,
    cost,
    speed,
    runningCostPerYear: Math.round(running / 10_000) * 10_000,
    power: d.power,
    maxCars,
    allow,
    color: d.color,
    comfort: allow === 'freight' ? 1 : Math.round(comfort * 100) / 100,
    desc: `自社開発・${DEV_POWER_NAMES[d.power]}・${DEV_USE_NAMES[d.use]}`,
  };
}

/** 今の街の自社開発の機関車を、車両の表に入れ直す（新しいゲーム・読み込み・完成・改修のとき） */
export function syncDesigns(world: World) {
  clearDevEngines();
  for (const d of world.designs ?? []) if (d.done !== undefined) registerDevEngine(devKey(d), designSpec(d));
}

/** 車庫で買える機関車の一覧（はじめからある機関車＋できあがった自社開発） */
export function engineList(world: World): EngineType[] {
  return [...ENGINE_TYPES, ...(world.designs ?? []).filter((d) => d.done !== undefined).map(devKey)];
}

export function currentDesign(world: World): Design | undefined {
  return world.designs?.find((d) => d.done === undefined);
}

/** ★の数。ポイントの合計を、予算の基準と比べる */
function rate(d: Design): number {
  const total = DEV_STATS.reduce((s, k) => s + d.pts[k], 0);
  const q = total / DEV.budgets[d.budget].pool;
  let r = q < 0.85 ? 1 : q < 1 ? 2 : q < 1.2 ? 3 : q < 1.45 ? 4 : 5;
  if (d.defect) r = Math.max(1, r - 1);
  return r;
}

const FAME_BY_RATING = [-2, 0, 3, 6, 10];

export function fameLabel(fame: number): string {
  return fame >= 60 ? '名門' : fame >= 30 ? '評判のメーカー' : fame >= 10 ? '知る人ぞ知る' : '無名';
}

export interface DevPlan {
  name: string;
  power: DevPower;
  use: DevUse;
  budget: number;
  color?: number;
}

/** 開発をはじめられるか（だめなら理由） */
export function devStartError(world: World, plan: DevPlan): string | null {
  if (currentDesign(world)) return '開発中の機関車があります（同時にひとつだけ）';
  if ((world.designs?.length ?? 0) >= DEV.maxDesigns) return `自社開発は${DEV.maxDesigns}形式までです`;
  const b = DEV.budgets[plan.budget];
  if (!b) return '予算を選んでください';
  if (!devPowerOk(world, plan.power)) return `電気の機関車は${ELECTRIFY_YEAR}年から開発できます`;
  if (!plan.name.trim()) return '名前を付けてください';
  if (world.money < b.cost) return 'お金が足りません';
  return null;
}

export function defaultDesignName(world: World, power: DevPower): string {
  const letter = { steam: 'C', diesel: 'D', electric: 'E' }[power];
  const n = (world.designs?.length ?? 0) + 1;
  return `${letter}${n}0形`;
}

export function startDesign(world: World, plan: DevPlan): Design | string {
  const err = devStartError(world, plan);
  if (err) return err;
  const b = DEV.budgets[plan.budget];
  spend(world, 'vehicles', b.cost);
  const d: Design = {
    id: world.nextId++,
    name: plan.name.trim().slice(0, 16),
    power: plan.power,
    use: plan.use,
    budget: plan.budget,
    color: plan.color ?? DEV.colors[(world.designs?.length ?? 0) % DEV.colors.length],
    start: world.day,
    days: b.days,
    progress: 0,
    pts: { speed: 0, might: 0, economy: 0, comfort: 0 },
    tests: [],
  };
  (world.designs ??= []).push(d);
  world.version++;
  pushEvent(world, { type: 'news', text: `${d.name}の開発をはじめました（${DEV_POWER_NAMES[d.power]}・${DEV_USE_NAMES[d.use]}・${b.days}日）`, tone: 'info' });
  return d;
}

/** 毎日：開発を1日進める */
export function develDaily(world: World) {
  const d = currentDesign(world);
  if (!d || d.waiting) return;
  const b = DEV.budgets[d.budget];
  const w = weights(d.power, d.use);
  const perDay = (b.pool * compat(d.power, d.use)) / d.days;
  DEV_STATS.forEach((k, i) => {
    d.pts[k] += perDay * w[i] * (0.6 + world.rng.next() * 0.8);
  });
  d.progress++;
  const ti = d.tests.length;
  if (ti < DEV.tests.length && d.progress >= Math.round(d.days * DEV.tests[ti])) {
    d.waiting = true;
    pushEvent(world, {
      type: 'news',
      text: `${d.name}の${DEV.testNames[ti]}です。自社開発の画面で方針を選んでください（選ぶまで開発は止まります）`,
      tone: 'info',
    });
  }
  if (d.progress >= d.days) finishDesign(world, d);
}

/** 試験の成功率（技術点などで上がる予定。いまは方針だけで決まる） */
export function testChance(_world: World, choice: TestChoice): number {
  return DEV.choices[choice].chance;
}

/** 試験の方針を選ぶ。結果を返す */
export function chooseTest(world: World, id: number, choice: TestChoice): TestResult | null {
  const d = world.designs?.find((x) => x.id === id);
  if (!d || !d.waiting || d.done !== undefined) return null;
  const ti = d.tests.length;
  const c = DEV.choices[choice];
  const ok = world.rng.chance(testChance(world, choice));
  const total = DEV.budgets[d.budget].pool;
  if (ok) {
    for (const k of DEV.testStats[ti]) d.pts[k] += (total * c.bonus) / DEV.testStats[ti].length;
  } else if (choice === 'bold') {
    for (const k of DEV_STATS) d.pts[k] *= 1 - DEV.setback;
  } else if (choice === 'daring') {
    d.defect = true;
  }
  const res: TestResult = { choice, ok };
  d.tests.push(res);
  d.waiting = false;
  world.version++;
  const name = DEV.testNames[ti];
  const text = ok
    ? `${d.name}の${name}は大成功！（${c.name}）${DEV.testStats[ti].map((k) => DEV_STAT_NAMES[k]).join('と')}が伸びました`
    : choice === 'daring'
      ? `${d.name}の${name}で不具合が見つかりました（${c.name}）。初期不良をかかえたまま完成します（あとで改修できます）`
      : choice === 'bold'
        ? `${d.name}の${name}はうまくいきませんでした（${c.name}）。少しやり直しです`
        : `${d.name}の${name}は予定どおりでした（${c.name}）`;
  pushEvent(world, { type: 'news', text, tone: ok ? 'good' : choice === 'daring' ? 'bad' : 'info' });
  return res;
}

function finishDesign(world: World, d: Design) {
  d.done = world.day;
  d.waiting = false;
  d.rating = rate(d);
  world.devFame = Math.max(0, Math.min(100, (world.devFame ?? 0) + FAME_BY_RATING[d.rating - 1]));
  syncDesigns(world);
  world.version++;
  const stars = '★'.repeat(d.rating) + '☆'.repeat(5 - d.rating);
  pushEvent(world, {
    type: 'news',
    text: `${d.name}が完成しました！ 評価 ${stars}・相性${compatMark(d.power, d.use)}${d.defect ? '・初期不良あり' : ''}（車庫で買えます）`,
    tone: 'good',
  });
}

export function fixCost(d: Design): number {
  return Math.round(DEV.budgets[d.budget].cost * DEV.fixCostRate);
}

/** 初期不良を改修する（維持費が元に戻り、評価も戻る） */
export function fixDefect(world: World, id: number): string | null {
  const d = world.designs?.find((x) => x.id === id);
  if (!d || !d.defect || d.done === undefined) return '改修するところがありません';
  const cost = fixCost(d);
  if (world.money < cost) return 'お金が足りません';
  spend(world, 'vehicles', cost);
  d.defect = false;
  const before = d.rating ?? 1;
  d.rating = rate(d);
  world.devFame = Math.max(0, Math.min(100, (world.devFame ?? 0) + (d.rating - before) * 2));
  syncDesigns(world);
  world.version++;
  pushEvent(world, { type: 'news', text: `${d.name}の初期不良を改修しました`, tone: 'good' });
  return null;
}

/** 開発をやめる（開発費は戻らない） */
export function cancelDesign(world: World, id: number): boolean {
  const i = world.designs?.findIndex((x) => x.id === id && x.done === undefined) ?? -1;
  if (i < 0) return false;
  const d = world.designs!.splice(i, 1)[0];
  world.version++;
  pushEvent(world, { type: 'news', text: `${d.name}の開発をやめました`, tone: 'info' });
  return true;
}

/** 旅客の運賃の倍率（快適な自社開発の機関車） */
export function comfortMul(t: EngineType): number {
  return ENGINE_SPECS[t]?.comfort ?? 1;
}
