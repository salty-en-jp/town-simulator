// マップ生成（フェーズ0：平地・川・森、町2つ、森林と製材所）

import { INDUSTRY } from './constants';
import { growHouse, housesByTown, refreshStats } from './simulate';
import {
  createEmptyWorld,
  idx,
  inBounds,
  newId,
  Terrain,
  type Industry,
  type IndustryType,
  type Town,
  type World,
} from './world';

const TOWN_NAMES = ['桜川', '青葉台', '若松', '梅ヶ丘', '日向', '水沢', '朝霧', '双葉', '柳瀬', '高森', '白浜', '川辺', '緑ヶ丘', '星野'];

export function generateWorld(seed: number, size = 64): World {
  const world = createEmptyWorld(size, size, seed);
  const rng = world.rng;
  const s = size / 64;

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
  let rx = Math.round(size * 0.5) + rng.int(-2, 2);
  let drift = 0;
  for (let y = 0; y < size; y++) {
    drift = Math.max(-1, Math.min(1, drift + rng.int(-1, 1) * 0.5));
    if (rng.chance(0.5)) rx += Math.round(drift);
    rx = Math.max(Math.round(size * 0.44), Math.min(Math.round(size * 0.58), rx));
    const width = rng.chance(0.3) ? 2 : 1;
    for (let k = 0; k < width; k++) world.terrain[idx(world, rx + k, y)] = Terrain.Water;
    // 次の行とつながるように、横に曲がったところを埋める
    if (y + 1 < size) world.terrain[idx(world, rx, y + 1)] = Terrain.Water;
  }

  const names = [...TOWN_NAMES];
  const takeName = () => names.splice(rng.int(0, names.length - 1), 1)[0];

  // 町：川の西（近い町）と東（遠い町）
  const townA = addTown(world, takeName(), Math.round(12 * s) + rng.int(-2, 2), Math.round(42 * s) + rng.int(-4, 4));
  const townB = addTown(world, takeName(), Math.round(50 * s) + rng.int(-2, 2), Math.round(22 * s) + rng.int(-5, 5));

  // 産業：森林と製材所は川の西側
  addIndustry(world, 'forest', `${townA.name}の森`, Math.round(12 * s) + rng.int(-3, 3), Math.round(8 * s) + rng.int(-2, 2), 3, 3);
  addIndustry(world, 'sawmill', `${townA.name}製材所`, Math.round(21 * s) + rng.int(-2, 2), Math.round(25 * s) + rng.int(-3, 3), 3, 2);

  // 町の最初の家
  const initial: [Town, number][] = [
    [townA, 10],
    [townB, 16],
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

export function addTown(world: World, name: string, cx: number, cy: number): Town {
  clearArea(world, cx - 2, cy - 2, 5, 5);
  const id = newId(world);
  const town: Town = {
    id,
    name,
    cx,
    cy,
    lumber: 0,
    growthTimer: 30 + world.rng.int(0, 20),
    lumberReceivedThisMonth: 0,
    lumberReceivedLastMonth: 0,
    paxReceivedThisMonth: 0,
    paxReceivedLastMonth: 0,
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
  const ind: Industry = {
    id,
    type,
    name,
    x,
    y,
    w,
    h,
    inStock: 0,
    outStock: 0,
    prodRate: type === 'forest' ? INDUSTRY.forestStartRate : INDUSTRY.sawmillRate,
    producedThisMonth: 0,
    transportedThisMonth: 0,
    receivedThisMonth: 0,
    producedLastMonth: 0,
    transportedLastMonth: 0,
    receivedLastMonth: 0,
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
