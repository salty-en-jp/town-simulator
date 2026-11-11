// 取引先：港と空港（v0.9.0）
//
// ・港：海のあるマップ（いろいろ・海沿い）の海辺に1つ。どんな貨物も輸出として買い取り（海外の相場）、輸入した石油を出す
//   石油は化学工場で日用品になり、町・都市が欲しがる。港ができたら、化学工場も1つ置く
// ・空港：1970年から、都市（人口5,000人）になった町のそばに1つ。旅客を高い運賃で受け入れ、出張や観光の旅客を出す
// ・どちらも取引先（ほかの会社が運営）。権利の購入・契約・増産はできない（自社の航路は、あとの版で）
// ・前の版のセーブにも、毎月たしかめて置く

import { AIRPORT_YEAR, INDUSTRY_SPECS, PARTNER_NAMES, type IndustryType } from './constants';
import { canPlaceIndustry, placeIndustryAt, placeIndustrySomewhere } from './industries';
import { townStage } from './towns';
import { dateOf, idx, pushEvent, Terrain, townLabel, type Industry, type Town, type World } from './world';

const has = (world: World, type: IndustryType) => [...world.industries.values()].some((i) => i.type === type);

/** 海のあるマップか（いろいろ・海沿い。前の版のセーブで地形がないときは「いろいろ」） */
export function hasSea(world: World): boolean {
  const l = world.landform ?? 'mixed';
  return l === 'mixed' || l === 'coast';
}

/** 町のまわりに置く（町の中心から少し離れたところ） */
function placeNear(world: World, type: IndustryType, town: Town): Industry | null {
  const spec = INDUSTRY_SPECS[type];
  for (let r = 7; r <= 16; r++) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = Math.round(town.cx + Math.cos(a) * r - spec.w / 2),
        y = Math.round(town.cy + Math.sin(a) * r - spec.h / 2);
      if (canPlaceIndustry(world, type, x, y, false)) continue;
      const near = [...world.industries.values()].some((i) => Math.abs(i.x - x) < 7 && Math.abs(i.y - y) < 7);
      if (near) continue;
      return placeIndustryAt(world, type, x, y, 'public');
    }
  }
  return null;
}

/** 南の海の岸に港を置く（川や池のそばではなく、海の向こうへ出られるところ） */
function placePort(world: World): Industry | null {
  const spec = INDUSTRY_SPECS.port;
  // 列ごとに、下の端から続く水の上端（海岸線）を調べる
  const shore: { x: number; y: number }[] = [];
  for (let x = 2; x < world.w - spec.w - 2; x++) {
    let y = world.h - 1;
    while (y > 0 && world.terrain[idx(world, x + 1, y)] === Terrain.Water) y--;
    if (world.h - 1 - y >= 4) shore.push({ x, y: y - spec.h + 1 });
  }
  for (const spacing of [true, false]) {
    const order = [...shore];
    for (let i = order.length - 1; i > 0; i--) {
      const j = world.rng.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const c of order) {
      for (const dy of [0, -1, 1, -2]) {
        if (!canPlaceIndustry(world, 'port', c.x, c.y + dy, spacing)) return placeIndustryAt(world, 'port', c.x, c.y + dy, 'public');
      }
    }
  }
  return null;
}

/** 港（と化学工場）を置く。マップをつくるときと、前の版のセーブ */
export function ensurePort(world: World, news: boolean) {
  if (world.noPort || !hasSea(world)) return;
  if (!has(world, 'port')) {
    const port = placePort(world);
    if (!port) {
      world.noPort = true;
      return;
    }
    if (news)
      pushEvent(world, {
        type: 'news',
        text: `${port.name}が開かれました（${PARTNER_NAMES.port}）。どんな貨物も輸出として買い取り、石油を出します`,
        tone: 'good',
        tile: idx(world, port.x, port.y),
      });
  }
  // 石油の行き先がないと困るので、化学工場も1つ
  if (!has(world, 'chemplant')) placeIndustrySomewhere(world, 'chemplant', 'public');
}

/** 空港：1970年から、都市になった町のそばに */
export function ensureAirport(world: World) {
  if (world.noAirport || has(world, 'airport') || dateOf(world.day).y < AIRPORT_YEAR) return;
  const cities = [...world.towns.values()].filter((t) => townStage(t) >= 2).sort((a, b) => b.population - a.population);
  if (!cities.length) return;
  for (const town of cities) {
    const ap = placeNear(world, 'airport', town);
    if (ap) {
      ap.name = `${town.name}空港`;
      world.version++;
      pushEvent(world, {
        type: 'news',
        text: `${townLabel(town)}のそばに${ap.name}ができました（${PARTNER_NAMES.airport}）。空の旅の旅客を、高い運賃で受け入れます`,
        tone: 'good',
        tile: idx(world, ap.x, ap.y),
      });
      return;
    }
  }
  world.noAirport = true;
}

export function partnersMonthly(world: World) {
  ensurePort(world, true);
  ensureAirport(world);
}

/** 取引先の運営会社の名前 */
export function partnerName(ind: Industry): string | undefined {
  const p = INDUSTRY_SPECS[ind.type].partner;
  return p ? PARTNER_NAMES[p] : undefined;
}
