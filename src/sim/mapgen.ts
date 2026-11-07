// マップ生成：平地・川・森、町4つ、産業12か所
//
// ・最初の「森 → 製材所 → 町」は、川を渡らずに近くでつくれるように置く（はじめの目標用）
// ・ほかの産業は、ほどよく離して置く。同じ種類の工場が複数あると「どこへ運ぶか」を選べる

import { INDUSTRY_SPECS, type IndustryType } from './constants';
import { growHouse, housesByTown, refreshStats } from './simulate';
import { createEmptyWorld, idx, inBounds, newId, Terrain, type Industry, type Town, type World } from './world';

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

export function generateWorld(seed: number, size = 96): World {
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

  // 町：川の西に2つ、東に2つ
  const townA = addTown(world, takeName(), at(0.19) + j(2), at(0.66) + j(4));
  const townB = addTown(world, takeName(), at(0.78) + j(2), at(0.34) + j(5));
  const townC = addTown(world, takeName(), at(0.8) + j(3), at(0.8) + j(3));
  const townD = addTown(world, takeName(), at(0.22) + j(3), at(0.2) + j(3));

  // 最初のチェーン：森と製材所は川の西側、町Aの近く
  placeAt(world, 'forest', at(0.12) + j(2), at(0.36) + j(2));
  placeAt(world, 'sawmill', at(0.3) + j(2), at(0.48) + j(3));

  // ほかの産業は、空いている場所に間隔をあけて置く
  for (const type of OTHER_INDUSTRIES) placeSomewhere(world, type);

  // 町の最初の家
  const initial: [Town, number][] = [
    [townA, 10],
    [townB, 16],
    [townC, 12],
    [townD, 8],
  ];
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

/** いちばん近い町の名前を使って産業の名前をつける（重なったら次に近い町、それでもだめなら番号） */
function industryName(world: World, type: IndustryType, cx: number, cy: number): string {
  const suffix = INDUSTRY_SPECS[type].suffix;
  const taken = new Set([...world.industries.values()].map((i) => i.name));
  const towns = [...world.towns.values()].sort(
    (a, b) => Math.abs(a.cx - cx) + Math.abs(a.cy - cy) - (Math.abs(b.cx - cx) + Math.abs(b.cy - cy)),
  );
  for (const t of towns) if (!taken.has(`${t.name}${suffix}`)) return `${t.name}${suffix}`;
  const base = towns[0]?.name ?? 'ツナグ';
  for (let n = 2; ; n++) if (!taken.has(`${base}第${n}${suffix}`)) return `${base}第${n}${suffix}`;
}

function placeAt(world: World, type: IndustryType, x: number, y: number): Industry {
  const spec = INDUSTRY_SPECS[type];
  return addIndustry(world, type, industryName(world, type, x, y), x, y, spec.w, spec.h);
}

/** 置ける場所か：まわり1マスも含めて水・建物がなく、ほかの産業・町から離れている */
function canPlace(world: World, type: IndustryType, x: number, y: number): boolean {
  const { w, h } = INDUSTRY_SPECS[type];
  if (x < 2 || y < 2 || x + w + 2 > world.w || y + h + 2 > world.h) return false;
  for (let yy = y - 1; yy <= y + h; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const t = idx(world, xx, yy);
      if (world.terrain[t] === Terrain.Water || world.occ[t]) return false;
    }
  }
  const cx = x + w / 2,
    cy = y + h / 2;
  for (const ind of world.industries.values()) {
    if (Math.abs(ind.x + ind.w / 2 - cx) + Math.abs(ind.y + ind.h / 2 - cy) < 14) return false;
  }
  for (const t of world.towns.values()) {
    if (Math.abs(t.cx - cx) + Math.abs(t.cy - cy) < 10) return false;
  }
  return true;
}

function placeSomewhere(world: World, type: IndustryType): Industry | null {
  for (let tries = 0; tries < 400; tries++) {
    const x = world.rng.int(2, world.w - 6),
      y = world.rng.int(2, world.h - 6);
    if (canPlace(world, type, x, y)) return placeAt(world, type, x, y);
  }
  return null;
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

export function addIndustry(
  world: World,
  type: IndustryType,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Industry {
  x = Math.max(1, Math.min(world.w - w - 1, x));
  y = Math.max(1, Math.min(world.h - h - 1, y));
  clearArea(world, x - 1, y - 1, w + 2, h + 2);
  const id = newId(world);
  const spec = INDUSTRY_SPECS[type];
  const ind: Industry = {
    id,
    type,
    name,
    x,
    y,
    w,
    h,
    inputs: Object.fromEntries(spec.inputs.map((c) => [c, 0])),
    outStock: 0,
    prodRate: spec.rate,
    producedThisMonth: 0,
    transportedThisMonth: 0,
    receivedThisMonth: 0,
    producedLastMonth: 0,
    transportedLastMonth: 0,
    receivedLastMonth: 0,
    transportedTotal: 0,
    receivedTotal: 0,
  };
  world.industries.set(id, ind);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.occ[idx(world, xx, yy)] = { k: 'industry', id };
  // 森林のまわりは木を多めに
  if (type === 'forest') {
    for (let yy = y - 3; yy < y + h + 3; yy++) {
      for (let xx = x - 3; xx < x + w + 3; xx++) {
        if (!inBounds(world, xx, yy)) continue;
        const t = idx(world, xx, yy);
        if (!world.occ[t] && world.terrain[t] === Terrain.Grass && world.rng.chance(0.45)) world.terrain[t] = Terrain.Trees;
      }
    }
  }
  return ind;
}
