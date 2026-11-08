// イベント（町や産業に変化を起こして、遊びにメリハリをつける）
//
// 方針：プレイヤーの持ち物（線路・駅・列車・お金）には直接の損害を出さない。
// 何度でもやり直しやすい今のバランスをこわさないため。

import { DIRS, DX, DY, idx, inBounds, pushEvent, townLabel, tx, ty, type Town, type World } from './world';

export const EVENTS = {
  /** 1か月に火事が起きる確率（家1軒あたり）と上限 */
  firePerHouse: 1 / 400,
  fireMax: 0.1,
  /** これより小さい町では起きない */
  fireMinHouses: 8,
  /** 燃え広がる確率と、燃える家の上限 */
  fireSpread: 0.45,
  fireMaxHouses: 4,
};

function townHouses(world: World, town: Town): number[] {
  const out: number[] = [];
  for (let i = 0; i < world.occ.length; i++) {
    const o = world.occ[i];
    if (o?.k === 'house' && o.town === town.id) out.push(i);
  }
  return out;
}

/** 火事：家を1軒選んで燃やし、となりの家に燃え広がることがある。燃えた家の数を返す */
export function startFire(world: World, town: Town, at?: number): number {
  const houses = townHouses(world, town);
  if (!houses.length) return 0;
  const first = at ?? world.rng.pick(houses);
  const burned: number[] = [];
  const queue = [first];
  while (queue.length && burned.length < EVENTS.fireMaxHouses) {
    const t = queue.shift()!;
    const o = world.occ[t];
    if (o?.k !== 'house' || burned.includes(t)) continue;
    burned.push(t);
    world.occ[t] = null;
    for (const d of DIRS) {
      const x = tx(world, t) + DX[d],
        y = ty(world, t) + DY[d];
      if (!inBounds(world, x, y)) continue;
      const n = idx(world, x, y);
      if (world.occ[n]?.k === 'house' && world.rng.chance(EVENTS.fireSpread)) queue.push(n);
    }
  }
  if (!burned.length) return 0;
  world.version++;
  pushEvent(world, { type: 'fx', kind: 'fire', tiles: burned });
  pushEvent(world, {
    type: 'news',
    text: `${townLabel(town)}で火事がありました。家が${burned.length}軒焼けました（町がまた建て直します）`,
    tone: 'bad',
    tile: first,
  });
  return burned.length;
}

/** 毎月：町ごとに、家の数に応じた確率で火事が起きる */
export function eventsMonthly(world: World) {
  for (const town of world.towns.values()) {
    if (town.houses < EVENTS.fireMinHouses) continue;
    const p = Math.min(EVENTS.fireMax, town.houses * EVENTS.firePerHouse);
    if (world.rng.chance(p)) startFire(world, town);
  }
}
