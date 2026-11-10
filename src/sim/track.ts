// 線路の経路探索と、ドラッグで引く線のタイル列

import { connected, DIRS, idx, isElectric, tx, ty, type World } from './world';

/**
 * start から goals のいずれかまでの最短経路（幅優先探索）。
 * 見つからなければ null。戻り値は start を含むタイル列。
 */
export function findPath(world: World, start: number, goals: Set<number>, electricOnly = false): number[] | null {
  if (goals.has(start)) return [start];
  const prev = new Int32Array(world.w * world.h).fill(-1);
  prev[start] = start;
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const d of DIRS) {
      const nb = connected(world, cur, d);
      if (nb < 0 || prev[nb] !== -1) continue;
      // 電気の車両は、電化したマスだけを通る
      if (electricOnly && !isElectric(world, nb)) continue;
      prev[nb] = cur;
      if (goals.has(nb)) {
        const path = [nb];
        let p = cur;
        while (p !== start) {
          path.push(p);
          p = prev[p];
        }
        path.push(start);
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

/**
 * ドラッグの始点から終点までのタイル列（オートレール風）。
 * 長い方の軸を先に進み、残りをもう一方の軸で進む L 字。
 */
export function dragLine(world: World, a: number, b: number, xFirstOpt?: boolean): number[] {
  const ax = tx(world, a),
    ay = ty(world, a),
    bx = tx(world, b),
    by = ty(world, b);
  const out: number[] = [];
  const xFirst = xFirstOpt ?? Math.abs(bx - ax) >= Math.abs(by - ay);
  let x = ax,
    y = ay;
  out.push(idx(world, x, y));
  const stepX = () => {
    while (x !== bx) {
      x += Math.sign(bx - x);
      out.push(idx(world, x, y));
    }
  };
  const stepY = () => {
    while (y !== by) {
      y += Math.sign(by - y);
      out.push(idx(world, x, y));
    }
  };
  if (xFirst) {
    stepX();
    stepY();
  } else {
    stepY();
    stepX();
  }
  return out;
}

/** 経由点を順に、縦横だけでつないだタイル列 */
export function polyLine(world: World, pts: [number, number][]): number[] {
  const out: number[] = [idx(world, pts[0][0], pts[0][1])];
  let [x, y] = pts[0];
  for (let k = 1; k < pts.length; k++) {
    const [tx2, ty2] = pts[k];
    while (x !== tx2) {
      x += Math.sign(tx2 - x);
      out.push(idx(world, x, y));
    }
    while (y !== ty2) {
      y += Math.sign(ty2 - y);
      out.push(idx(world, x, y));
    }
  }
  return out;
}

/** 始点から終点まで、一直線（長い方の軸）に揃えたタイル列。駅の配置用 */
export function straightLine(world: World, a: number, b: number, maxLen: number): number[] {
  const ax = tx(world, a),
    ay = ty(world, a),
    bx = tx(world, b),
    by = ty(world, b);
  const out: number[] = [];
  if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
    const s = Math.sign(bx - ax) || 1;
    const n = Math.min(Math.abs(bx - ax) + 1, maxLen);
    for (let k = 0; k < n; k++) out.push(idx(world, ax + s * k, ay));
  } else {
    const s = Math.sign(by - ay) || 1;
    const n = Math.min(Math.abs(by - ay) + 1, maxLen);
    for (let k = 0; k < n; k++) out.push(idx(world, ax, ay + s * k));
  }
  return out;
}

/** 長方形の範囲のタイル列（解体用） */
export function rectTiles(world: World, a: number, b: number): number[] {
  const x0 = Math.min(tx(world, a), tx(world, b));
  const x1 = Math.max(tx(world, a), tx(world, b));
  const y0 = Math.min(ty(world, a), ty(world, b));
  const y1 = Math.max(ty(world, a), ty(world, b));
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(idx(world, x, y));
  return out;
}
