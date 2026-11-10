// 自社開発した機関車の販売（v0.8.3）
//
// ・完成した機関車は、ほかの鉄道会社に売れる。完成から8年ほど、毎月注文が来る（だんだん減る）
// ・売れ方は：評価（★）・鉄道ファンの評判・時代の流行（動力の人気と、その年に人気の用途）・
//   自分の路線で走らせている数（PR）・値段・初期不良
// ・他社からの注文：「○○用の機関車を、何年以内に★いくつ以上で」。完成させると、まとめて売れる
// ・毎年1月に「鉄道車両大賞」。前の年に完成した自社の機関車が、ライバルのメーカーと競う
// 方針：売れなくても損はしない（つくる分のお金は、売れた分の利益から引いてある）

import { DEV_POWER_NAMES, DEV_USE_NAMES, DEV_USES, type DevPower, type DevUse } from './constants';
import { compat, designSpec, devKey, hasMaker, type Design } from './devel';
import { dateOf, earn, pushEvent, type World } from './world';
import { partMakeCost } from './tech';

export interface SaleState {
  on: boolean;
  /** 値段の段階（SALES.markups の番号） */
  markup: number;
  /** 売れた両数・利益の合計 */
  sold: number;
  profit: number;
  /** 先月売れた両数 */
  lastMonth: number;
  /** 端数の注文（たまったら1両） */
  acc: number;
  /** 販売を終えた */
  ended?: boolean;
}

export interface DevOrder {
  id: number;
  from: string;
  use: DevUse;
  power?: DevPower;
  minRating: number;
  deadline: number;
  units: number;
}

export interface Award {
  year: number;
  /** 受賞した機関車とメーカー */
  name: string;
  maker: string;
  mine: boolean;
}

export const SALES = {
  /** 何年売れるか */
  years: 8,
  /** 基本の注文（月あたりの両数） */
  base: 0.25,
  /** 予算の大きい機関車ほど注目される（試作・本格・社運をかけた） */
  budgetMul: [0.5, 1.2, 2.5],
  /** 値段：機関車の値段に対する倍率。つくる費用は 0.75 */
  markups: [0.9, 1, 1.15, 1.3],
  markupNames: ['安め', 'ふつう', '高め', '強気'],
  makeCost: 0.75,
  quality: [0.3, 0.6, 1, 1.5, 2.2],
  trendMul: 1.5,
  /** 他社からの注文：毎年の確率・数・期限 */
  orderChance: 0.6,
  maxOrders: 2,
  orderYears: 3,
  /** 注文をかなえたときの利益（機関車の値段 × 両数 × これ） */
  orderMargin: 0.4,
  awardPrize: 30_000_000,
};

export const CUSTOMERS = ['北辰鉄道', '港南電鉄', '山城鉄道', '白浜急行', '湖西鉄道', '桜ヶ丘電鉄', '峠越え鉄道'];
/** 観光用の注文は、観光の大手から */
export const TOURISM_CUSTOMER = 'シルフィード社';
export const RIVAL_MAKER = 'ハルモニア・レールウェイズ';
const RIVAL_NAMES = ['カナデ形', 'シラベ形', 'ヒビキ形', 'ユニゾン形', 'コーダ形', 'リフレイン形', 'カデンツ形', 'フーガ形'];

/** 時代ごとの動力の人気（1 がふつう） */
export function powerEra(power: DevPower, year: number): number {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
  if (power === 'steam') return year < 1965 ? 1 : Math.max(0.15, 1 - (year - 1965) * 0.06);
  if (power === 'diesel') return year < 1970 ? lerp(0.8, 1.2, (year - 1960) / 10) : year < 1990 ? 1.2 : lerp(1.2, 0.8, (year - 1990) / 15);
  return lerp(0.5, 1.4, (year - 1965) / 20);
}

export function eraLabel(m: number): string {
  return m >= 1.15 ? '人気' : m >= 0.85 ? 'ふつう' : m >= 0.5 ? '下火' : 'ほとんど売れない';
}

export function saleOf(d: Design): SaleState {
  return (d.sale ??= { on: true, markup: 1, sold: 0, profit: 0, lastMonth: 0, acc: 0 });
}

/** 自分の路線で走っている数（PR） */
export function runningCount(world: World, d: Design): number {
  const k = devKey(d);
  let n = 0;
  for (const t of world.trains.values()) if (t.cars[0]?.type === k && t.state !== 'in_depot') n++;
  return n;
}

/** 1両売れたときの利益 */
export function unitProfit(world: World, d: Design): number {
  const s = saleOf(d);
  return Math.round(designSpec(d).cost * (SALES.markups[s.markup] - SALES.makeCost + partMakeCost(world)));
}

/** 1か月に来る注文のめやす（両） */
export function monthlyDemand(world: World, d: Design): number {
  if (d.done === undefined) return 0;
  const s = saleOf(d);
  const age = (world.day - d.done) / 365;
  if (age >= SALES.years) return 0;
  const life = age < 1 ? 1.3 : Math.max(0, 1 - (age - 1) / (SALES.years - 1));
  const y = dateOf(world.day).y;
  const trend = world.devTrend?.use === d.use ? SALES.trendMul : 1;
  const pr = 1 + Math.min(1, runningCount(world, d) * 0.15);
  const price = Math.pow(SALES.markups[s.markup], -3);
  return (
    SALES.base *
    SALES.budgetMul[d.budget] *
    SALES.quality[(d.rating ?? 1) - 1] *
    (1 + (world.devFame ?? 0) / 50) *
    powerEra(d.power, y) *
    trend *
    pr *
    price *
    life *
    (d.defect ? 0.6 : 1)
  );
}

/** 毎月：注文を受けて売る */
export function salesMonthly(world: World) {
  for (const d of world.designs ?? []) {
    if (d.done === undefined) continue;
    const s = saleOf(d);
    s.lastMonth = 0;
    if (s.ended) continue;
    if ((world.day - d.done) / 365 >= SALES.years) {
      s.ended = true;
      pushEvent(world, { type: 'news', text: `${d.name}の販売が終わりました（${s.sold}両・利益${Math.round(s.profit / 10_000).toLocaleString('ja-JP')}万円）`, tone: 'info' });
      continue;
    }
    if (!s.on) continue;
    s.acc += monthlyDemand(world, d) * (0.7 + world.rng.next() * 0.6);
    const units = Math.floor(s.acc);
    if (units <= 0) continue;
    s.acc -= units;
    const profit = units * unitProfit(world, d);
    const first = s.sold === 0;
    s.sold += units;
    s.profit += profit;
    s.lastMonth = units;
    earn(world, 'devel', profit);
    world.devFame = Math.min(100, (world.devFame ?? 0) + units * 0.05);
    if (first) pushEvent(world, { type: 'news', text: `${d.name}がはじめて売れました！（${units}両）`, tone: 'good' });
    else if (Math.floor((s.sold - units) / 10) !== Math.floor(s.sold / 10))
      pushEvent(world, { type: 'news', text: `${d.name}が累計${Math.floor(s.sold / 10) * 10}両売れました`, tone: 'good' });
  }
  // 期限の過ぎた注文
  const orders = world.devOrders ?? [];
  for (const o of orders) {
    if (o.deadline <= world.day) pushEvent(world, { type: 'news', text: `${o.from}からの注文（${orderText(o)}）は、期限が過ぎました`, tone: 'info' });
  }
  world.devOrders = orders.filter((o) => o.deadline > world.day);
}

export function orderText(o: DevOrder): string {
  return `${o.power ? DEV_POWER_NAMES[o.power] : ''}${o.power ? 'の' : ''}${DEV_USE_NAMES[o.use]}用・★${o.minRating}以上・${o.units}両`;
}

export function orderMatches(o: DevOrder, d: Design): boolean {
  return d.use === o.use && (!o.power || d.power === o.power) && (d.rating ?? 0) >= o.minRating;
}

/** 機関車が完成したとき：かなった注文があれば、まとめて売る */
export function salesOnDesignDone(world: World, d: Design) {
  const orders = world.devOrders ?? [];
  const hit = orders.filter((o) => orderMatches(o, d));
  for (const o of hit) {
    const amount = Math.round(designSpec(d).cost * o.units * SALES.orderMargin);
    earn(world, 'devel', amount);
    const s = saleOf(d);
    s.sold += o.units;
    s.profit += amount;
    world.devFame = Math.min(100, (world.devFame ?? 0) + 5);
    pushEvent(world, {
      type: 'news',
      text: `${o.from}からの注文に応えました！ ${d.name}を${o.units}両納め、${Math.round(amount / 10_000).toLocaleString('ja-JP')}万円の利益`,
      tone: 'good',
    });
  }
  world.devOrders = orders.filter((o) => !hit.includes(o));
}

/** 毎年1月：流行の用途・他社からの注文・鉄道車両大賞 */
export function salesYearly(world: World) {
  const y = dateOf(world.day).y;
  const rng = world.rng;
  // その年に人気の用途
  const use = rng.pick([...DEV_USES]);
  world.devTrend = { use, year: y };
  const anyDesign = (world.designs?.length ?? 0) > 0;
  if (anyDesign) pushEvent(world, { type: 'news', text: `今年は${DEV_USE_NAMES[use]}用の機関車が人気です（鉄道各社の買い付け）`, tone: 'info' });

  // 他社からの注文
  world.devOrders ??= [];
  if (hasMaker(world) && world.devOrders.length < SALES.maxOrders && rng.chance(SALES.orderChance)) {
    const ou = rng.pick([...DEV_USES]);
    const powers: DevPower[] = y >= 1965 ? ['steam', 'diesel', 'electric'] : ['steam', 'diesel'];
    const o: DevOrder = {
      id: world.nextId++,
      from: ou === 'tourist' ? TOURISM_CUSTOMER : rng.pick(CUSTOMERS),
      use: ou,
      power: rng.chance(0.5) ? rng.pick(powers) : undefined,
      minRating: (world.devFame ?? 0) >= 30 ? 4 : 3,
      deadline: world.day + 365 * SALES.orderYears,
      units: 4 + Math.floor(rng.next() * 7),
    };
    world.devOrders.push(o);
    pushEvent(world, { type: 'news', text: `${o.from}から機関車の注文が来ました：${orderText(o)}（${SALES.orderYears}年以内。自社開発の画面で）`, tone: 'good' });
  }

  // 鉄道車両大賞（前の年に完成した機関車）
  const last = (world.designs ?? []).filter((d) => d.done !== undefined && dateOf(d.done).y === y - 1);
  const rival = 55 + rng.next() * 30 + Math.min(20, (y - 1960) * 0.6);
  let best: Design | undefined;
  let bestScore = -1;
  for (const d of last) {
    const c = compat(d.power, d.use);
    const score = (d.rating ?? 1) * 18 + (c >= 1.3 ? 8 : c >= 1 ? 0 : -5) + d.budget * 4 + (d.defect ? -10 : 0) + rng.next() * 10;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  world.awards ??= [];
  if (best && bestScore > rival) {
    world.awards.push({ year: y - 1, name: best.name, maker: '', mine: true });
    best.award = y - 1;
    earn(world, 'devel', SALES.awardPrize);
    world.devFame = Math.min(100, (world.devFame ?? 0) + 10);
    pushEvent(world, {
      type: 'news',
      text: `${y - 1}年の鉄道車両大賞は、わが社の${best.name}！ 賞金${SALES.awardPrize / 10_000}万円と、評判が大きく上がりました`,
      tone: 'good',
    });
  } else if (y > 1961) {
    const name = RIVAL_NAMES[(y - 1961) % RIVAL_NAMES.length];
    world.awards.push({ year: y - 1, name, maker: RIVAL_MAKER, mine: false });
    if (anyDesign)
      pushEvent(world, {
        type: 'news',
        text: `${y - 1}年の鉄道車両大賞は、${RIVAL_MAKER}の${name}でした${best ? `（わが社の${best.name}は届きませんでした）` : ''}`,
        tone: 'info',
      });
  }
  if (world.awards.length > 40) world.awards.splice(0, world.awards.length - 40);
}
