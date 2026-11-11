// 港・空港の買収と、自社の航路（v0.9.2）
//
// ・取引先の港・空港を買い取ると、自社の施設になる（港5億円・空港8億円）
// ・買い取った港・空港から、海の向こうの都市・遠くの都市への「航路」を開き、船・飛行機を入れる
// ・鉄道で港・空港へ届けた貨物・旅客のうち、航路で運べる分（1か月の量に上限）は、輸出・空の旅の代金に加えて
//   「海運・空輸の運賃」が入る。船・飛行機が多いほど、港の石油・空港の旅客（到着）も増える
// ・船の道さがしはしない。見た目だけ、港から海の方へ・空港からマップの外へ行き来する
// 方針：鉄道で集めてくるほど航路が儲かる（「つなぐ」が芯のまま）

import { INDUSTRY_SPECS } from './constants';
import { dateOf, earn, pushEvent, spend, type Industry, type World } from './world';

export type RouteKind = 'sea' | 'air';

export interface Route {
  id: number;
  /** 港・空港（産業の id） */
  from: number;
  kind: RouteKind;
  /** 行き先（ROUTE_NAMES の番号） */
  dest: number;
  /** 船・飛行機の数 */
  ships: number;
  /** 今月・先月に運んだ量と、先月の運賃 */
  carried: number;
  lastCarried: number;
  lastIncome: number;
  income: number;
  opened: number;
}

export interface Destination {
  name: string;
  /** 1単位（t・人）あたりの運賃 */
  fare: number;
}

/** 行き先（名前は src/data/zukan.md で書きかえられる） */
export const ROUTE_NAMES: Record<RouteKind, Destination[]> = {
  sea: [
    { name: 'ノルトシュタット', fare: 9_000 },
    { name: 'ポート・エリス', fare: 12_000 },
    { name: 'ヴェストブルク', fare: 15_000 },
  ],
  air: [
    { name: 'ブルックフィールド', fare: 30_000 },
    { name: 'ローゼンハイム', fare: 40_000 },
    { name: 'ニューケンブリッジ', fare: 50_000 },
  ],
};

export const ROUTES = {
  buyPrice: { port: 500_000_000, airport: 800_000_000 } as Record<string, number>,
  /** 船・飛行機1つの値段・1年の維持費・1か月に運べる量 */
  ship: {
    sea: { name: '船', unit: '隻', price: 100_000_000, runningPerYear: 10_000_000, capacity: 400 },
    air: { name: '飛行機', unit: '機', price: 200_000_000, runningPerYear: 30_000_000, capacity: 300 },
  },
  maxShips: 5,
  /** 1つの港・空港から開ける航路の数 */
  maxRoutes: 3,
  /** 船・飛行機1つあたり、港の石油・空港の旅客が毎月これだけ増える */
  extraOutput: { sea: 30, air: 100 },
};

export function partnerKind(ind: Industry): RouteKind | null {
  const p = INDUSTRY_SPECS[ind.type].partner;
  return p === 'port' ? 'sea' : p === 'airport' ? 'air' : null;
}

export function routesOf(world: World, indId: number): Route[] {
  return (world.routes ?? []).filter((r) => r.from === indId);
}

export function destName(r: Route): string {
  return ROUTE_NAMES[r.kind][r.dest]?.name ?? '？';
}

// ───────────── 買い取り ─────────────

export function buyPartnerError(world: World, ind: Industry): string | null {
  const p = INDUSTRY_SPECS[ind.type].partner;
  if (!p) return '取引先の施設ではありません';
  if (ind.owner === 'player') return 'もう自社の施設です';
  if (world.money < ROUTES.buyPrice[p]) return 'お金が足りません';
  return null;
}

export function buyPartner(world: World, id: number): string | null {
  const ind = world.industries.get(id);
  if (!ind) return '見つかりません';
  const err = buyPartnerError(world, ind);
  if (err) return err;
  const p = INDUSTRY_SPECS[ind.type].partner!;
  spend(world, 'routes', ROUTES.buyPrice[p]);
  ind.owner = 'player';
  world.version++;
  pushEvent(world, {
    type: 'news',
    text: `${ind.name}を買い取りました！ ${p === 'port' ? '航路を開いて、船を入れられます' : '空路を開いて、飛行機を入れられます'}（${ind.name}の窓から）`,
    tone: 'good',
  });
  return null;
}

// ───────────── 航路 ─────────────

export function openRouteError(world: World, ind: Industry, dest: number): string | null {
  const kind = partnerKind(ind);
  if (!kind) return '港・空港ではありません';
  if (ind.owner !== 'player') return '買い取ると、航路を開けます';
  if (!ROUTE_NAMES[kind][dest]) return '行き先がありません';
  const mine = routesOf(world, ind.id);
  if (mine.some((r) => r.dest === dest)) return 'その行き先には、もう航路があります';
  if (mine.length >= ROUTES.maxRoutes) return `航路は${ROUTES.maxRoutes}つまでです`;
  if (world.money < ROUTES.ship[kind].price) return 'お金が足りません';
  return null;
}

/** 航路を開く（船・飛行機を1つ買って入れる） */
export function openRoute(world: World, indId: number, dest: number): Route | string {
  const ind = world.industries.get(indId);
  if (!ind) return '見つかりません';
  const err = openRouteError(world, ind, dest);
  if (err) return err;
  const kind = partnerKind(ind)!;
  spend(world, 'routes', ROUTES.ship[kind].price);
  const r: Route = { id: world.nextId++, from: indId, kind, dest, ships: 1, carried: 0, lastCarried: 0, lastIncome: 0, income: 0, opened: world.day };
  (world.routes ??= []).push(r);
  world.version++;
  pushEvent(world, { type: 'news', text: `${ind.name}から${destName(r)}への${kind === 'sea' ? '航路' : '空路'}を開きました`, tone: 'good' });
  return r;
}

export function addShip(world: World, routeId: number): string | null {
  const r = world.routes?.find((x) => x.id === routeId);
  if (!r) return '航路がありません';
  if (r.ships >= ROUTES.maxShips) return `1つの航路に${ROUTES.maxShips}${ROUTES.ship[r.kind].unit}までです`;
  const price = ROUTES.ship[r.kind].price;
  if (world.money < price) return 'お金が足りません';
  spend(world, 'routes', price);
  r.ships++;
  world.version++;
  return null;
}

/** 船・飛行機を1つ減らす（半値で売る）。0になったら航路を閉じる */
export function removeShip(world: World, routeId: number): string | null {
  const r = world.routes?.find((x) => x.id === routeId);
  if (!r) return '航路がありません';
  earn(world, 'routes', Math.round(ROUTES.ship[r.kind].price / 2));
  r.ships--;
  if (r.ships <= 0) world.routes = world.routes!.filter((x) => x !== r);
  world.version++;
  return null;
}

/** 1か月に運べる量の合計（その港・空港） */
export function capacityOf(world: World, indId: number): number {
  return routesOf(world, indId).reduce((n, r) => n + r.ships * ROUTES.ship[r.kind].capacity, 0);
}

/** 船・飛行機の数に応じて、港の石油・空港の旅客が増える分（毎月） */
export function extraOutput(world: World, indId: number): number {
  return routesOf(world, indId).reduce((n, r) => n + r.ships * ROUTES.extraOutput[r.kind], 0);
}

/**
 * 港・空港に届いた貨物・旅客を航路に載せる。載せた分の運賃を返す（呼んだ側が受け取る）
 * 運賃の高い航路から順に、今月の空きの分だけ載せる
 */
export function loadRoutes(world: World, ind: Industry, amount: number): number {
  if (ind.owner !== 'player') return 0;
  const list = routesOf(world, ind.id).sort((a, b) => ROUTE_NAMES[b.kind][b.dest].fare - ROUTE_NAMES[a.kind][a.dest].fare);
  let left = amount,
    income = 0;
  for (const r of list) {
    if (left <= 0) break;
    const room = r.ships * ROUTES.ship[r.kind].capacity - r.carried;
    const take = Math.min(room, left);
    if (take <= 0) continue;
    r.carried += take;
    left -= take;
    const fare = Math.round(take * ROUTE_NAMES[r.kind][r.dest].fare);
    r.income += fare;
    income += fare;
  }
  return income;
}

/** 毎月：運んだ量を締めて、維持費を払う */
export function routesMonthly(world: World) {
  let cost = 0;
  for (const r of world.routes ?? []) {
    r.lastCarried = r.carried;
    r.lastIncome = r.income;
    r.carried = 0;
    r.income = 0;
    cost += (r.ships * ROUTES.ship[r.kind].runningPerYear) / 12;
  }
  if (cost > 0) spend(world, 'routes', Math.round(cost));
  // 港・空港がなくなっていたら、その航路も閉じる
  if (world.routes?.length) world.routes = world.routes.filter((r) => world.industries.has(r.from));
}

/** 船・飛行機の位置（描画用）：0..1 の行き来。i 番目の船は少しずらす */
export function shipPhase(world: World, r: Route, i: number): number {
  const period = r.kind === 'sea' ? 40 : 16; // 日
  const t = (world.day + (world.tick % 60) / 60) / period + i / r.ships + r.id * 0.37;
  const f = t - Math.floor(t);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

export function yearOf(world: World): number {
  return dateOf(world.day).y;
}
