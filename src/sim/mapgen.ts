// マップ生成：平地・川・森、町（広さで3〜6つ）、産業（広さで9〜18か所）
//
// ・最初の「森 → 製材所 → 町」は、川を渡らずに近くでつくれるように置く（はじめの目標用）
// ・ほかの産業は、ほどよく離して置く。同じ種類の工場が複数あると「どこへ運ぶか」を選べる

import { ensurePort } from './partners';
import type { IndustryType } from './constants';
import { placeIndustryAt, placeIndustrySomewhere } from './industries';
import { growHouse, housesByTown, refreshStats } from './simulate';
import { placeWorkshop } from './specialty';
import { createEmptyWorld, idx, inBounds, newId, Terrain, type Town, type World } from './world';

export { addIndustry } from './industries';

const TOWN_NAMES = ['桜川', '青葉台', '若松', '梅ヶ丘', '日向', '水沢', '朝霧', '双葉', '柳瀬', '高森', '白浜', '川辺', '緑ヶ丘', '星野'];

/** 最初のチェーンの次に置く産業（左から順に置く） */
const OTHER_INDUSTRIES: IndustryType[] = [
  'farm',
  'foodplant',
  'ironmine',
  'coalmine',
  'steelmill',
  'materialsplant',
  'forest',
  'sawmill',
  'farm',
  'coalmine',
];

/** 大きいマップで、さらに置く産業 */
const MORE_INDUSTRIES: IndustryType[] = ['ironmine', 'foodplant', 'forest', 'steelmill', 'farm', 'sawmill'];

/** マップの広さ（町と産業の数は広さで決まる） */
export const MAP_SIZES = {
  small: { name: '小さい', size: 64, desc: '町3つ。気軽に遊べる' },
  normal: { name: 'ふつう', size: 96, desc: '町4つ。これまでどおり' },
  large: { name: '大きい', size: 128, desc: '町6つ。じっくり広げたい人に（少し重くなります）' },
} as const;
export type MapSize = keyof typeof MAP_SIZES;

/** 地形（v0.7）：選んだ土地の割合が多くなる */
export const LANDFORMS = {
  mixed: { name: 'いろいろ', desc: '山も平野も海辺も少しずつ', rocks: 4, sea: 0.08, extra: [] as IndustryType[] },
  mountains: { name: '山がち', desc: '鉱山と森が多い。線路は高くつく', rocks: 10, sea: 0, extra: ['ironmine', 'coalmine', 'ranch'] as IndustryType[] },
  plains: { name: '平野', desc: '農場が多く、家を建てる土地が広い。線路が安い', rocks: 1, sea: 0, extra: ['farm', 'farm'] as IndustryType[] },
  coast: { name: '海沿い', desc: '南が海。漁港の魚で食品工場を回せる', rocks: 3, sea: 0.2, extra: ['fishery'] as IndustryType[] },
} as const;
export type Landform = keyof typeof LANDFORMS;

export function generateWorld(seed: number, size = 96, landform: Landform = 'mixed'): World {
  const land = LANDFORMS[landform];
  const world = createEmptyWorld(size, size, seed);
  const rng = world.rng;
  const s = size / 64;
  const at = (f: number) => Math.round(size * f);

  // 森（木の固まり）
  for (let k = 0; k < Math.round(16 * s * s); k++) {
    const cx = rng.int(0, size - 1),
      cy = rng.int(0, size - 1),
      r = rng.int(2, 5);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!inBounds(world, x, y)) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d <= 1 && rng.chance(0.85 - d * 0.6)) world.terrain[idx(world, x, y)] = Terrain.Trees;
      }
    }
  }

  // 川（上から下へ蛇行）
  let rx = at(0.5) + rng.int(-2, 2);
  let drift = 0;
  for (let y = 0; y < size; y++) {
    drift = Math.max(-1, Math.min(1, drift + rng.int(-1, 1) * 0.5));
    if (rng.chance(0.5)) rx += Math.round(drift);
    rx = Math.max(at(0.44), Math.min(at(0.58), rx));
    const width = rng.chance(0.3) ? 2 : 1;
    for (let k = 0; k < width; k++) world.terrain[idx(world, rx + k, y)] = Terrain.Water;
    // 次の行とつながるように、横に曲がったところを埋める
    if (y + 1 < size) world.terrain[idx(world, rx, y + 1)] = Terrain.Water;
  }

  const names = [...TOWN_NAMES];
  const takeName = () => names.splice(rng.int(0, names.length - 1), 1)[0];
  const j = (n: number) => rng.int(-n, n);

  // ── 海（南の海岸。海沿いは広く、いろいろは南東の湾だけ） ──
  const seaTop = new Array<number>(size).fill(size);
  if (land.sea > 0) {
    let y = at(1 - land.sea);
    for (let x = 0; x < size; x++) {
      y = Math.max(at(1 - land.sea) - 3, Math.min(at(1 - land.sea) + 3, y + rng.int(-1, 1)));
      // いろいろ：東側だけが湾になる
      if (landform === 'mixed' && x < at(0.6)) continue;
      seaTop[x] = y;
      for (let yy = y; yy < size; yy++) world.terrain[idx(world, x, yy)] = Terrain.Water;
    }
  }
  /** 町を海に置かないように、海岸より少し上へ */
  const landY = (x: number, y: number) => Math.min(y, seaTop[Math.max(0, Math.min(size - 1, x))] - 6);

  // ── 山地（岩場の固まり）。町と最初の森・製材所のまわりは避ける ──
  const keep = [
    [0.19, 0.66],
    [0.78, 0.34],
    [0.8, 0.8],
    [0.22, 0.2],
    [0.3, 0.9],
    [0.72, 0.1],
    [0.12, 0.36],
    [0.3, 0.48],
  ].map(([x, y]) => [at(x), at(y)]);
  for (let k = 0; k < Math.round(land.rocks * s * s); k++) {
    const cx = rng.int(0, size - 1),
      cy = rng.int(0, size - 1),
      r = rng.int(3, 7);
    if (keep.some(([kx, ky]) => Math.hypot(kx - cx, ky - cy) < r + 8)) continue;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!inBounds(world, x, y)) continue;
        const t = idx(world, x, y);
        if (world.terrain[t] === Terrain.Water) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d <= 1 && rng.chance(1.05 - d * 0.5)) world.terrain[t] = Terrain.Rock;
      }
    }
  }

  // 町：川の西に2つ、東に2つ
  // 町の数はマップの広さで決まる（小さい：3つ、ふつう：4つ、大きい：6つ）
  const town = (x: number, y: number) => addTown(world, takeName(), x, landY(x, y));
  const townA = town(at(0.19) + j(2), at(0.66) + j(4));
  const townB = town(at(0.78) + j(2), at(0.34) + j(5));
  const townC = town(at(0.8) + j(3), at(0.8) + j(3));
  const townD = size > 64 ? town(at(0.22) + j(3), at(0.2) + j(3)) : null;
  const townE = size >= 128 ? town(at(0.3) + j(3), at(0.9) + j(2)) : null;
  const townF = size >= 128 ? town(at(0.72) + j(3), at(0.1) + j(2)) : null;

  // 最初のチェーン：森と製材所は川の西側、町Aの近く（地元の産業：だれでも運べる）
  placeIndustryAt(world, 'forest', at(0.12) + j(2), at(0.36) + j(2), 'public');
  placeIndustryAt(world, 'sawmill', at(0.3) + j(2), at(0.48) + j(3), 'public');

  // ほかの産業は、空いている場所に間隔をあけて置く。
  // 各種類の1つめは地元の産業、2つめからは他社（権利を買うか輸送契約で運べる）
  // 小さいマップは少なめ、大きいマップは多め
  const base = size <= 64 ? OTHER_INDUSTRIES.slice(0, 7) : size >= 128 ? [...OTHER_INDUSTRIES, ...MORE_INDUSTRIES] : OTHER_INDUSTRIES;
  // 牧場はどの地形にも1つ。海があれば漁港。地形ごとの得意な産業を足す
  const others: IndustryType[] = [...base, 'ranch', ...(land.sea > 0 ? (['fishery'] as IndustryType[]) : []), ...land.extra];
  for (const type of others) {
    const has = [...world.industries.values()].some((i) => i.type === type);
    placeIndustrySomewhere(world, type, has ? 'other' : 'public');
  }
  world.landform = landform;

  // 町の最初の家
  const initial = (
    [
      [townA, 10],
      [townB, 16],
      [townC, 12],
      [townD, 8],
      [townE, 9],
      [townF, 11],
    ] as [Town | null, number][]
  ).filter((x): x is [Town, number] => x[0] !== null);
  for (const [town, n] of initial) {
    const hb = housesByTown(world);
    const houses = hb.get(town.id)!;
    for (let k = 0; k < n; k++) {
      const t = growHouse(world, town, houses, []);
      if (t >= 0) houses.push(t);
    }
    // 中心近くの何軒かはアパートに
    for (const t of houses.slice(0, Math.floor(n / 4))) {
      const o = world.occ[t];
      if (o?.k === 'house') world.occ[t] = { ...o, level: 2 };
    }
  }
  refreshStats(world);
  // どの町にも、そばに名産の工房を1つ（種類はまわりの土地で決まる）
  for (const t of world.towns.values()) placeWorkshop(world, t);
  // 海のあるマップには港（と化学工場）
  ensurePort(world, false);
  world.version++;
  return world;
}

function clearArea(world: World, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (inBounds(world, x, y)) world.terrain[idx(world, x, y)] = Terrain.Grass;
    }
  }
}

export function addTown(world: World, name: string, cx: number, cy: number): Town {
  clearArea(world, cx - 2, cy - 2, 5, 5);
  const id = newId(world);
  const town: Town = {
    id,
    name,
    cx,
    cy,
    stock: {},
    recv: {},
    growthTimer: 30 + world.rng.int(0, 20),
    fed: false,
    population: 0,
    houses: 0,
    activeStations: 0,
  };
  world.towns.set(id, town);
  return town;
}

