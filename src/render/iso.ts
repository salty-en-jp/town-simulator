// 斜め見下ろし（アイソメトリック）の座標変換

export const TW = 64; // タイルの幅（画面px）
export const TH = 32; // タイルの高さ（画面px）

/** タイル座標（小数可）→ ワールド座標（px）。タイル中心が整数座標 */
export function isoX(x: number, y: number): number {
  return ((x - y) * TW) / 2;
}
export function isoY(x: number, y: number): number {
  return ((x + y) * TH) / 2;
}

/** ワールド座標（px）→ タイル座標（小数） */
export function worldToTile(px: number, py: number): { x: number; y: number } {
  const a = py / (TH / 2);
  const b = px / (TW / 2);
  return { x: (a + b) / 2, y: (a - b) / 2 };
}

/** 地面上の点の列を画面座標の配列に */
export function groundPoly(pts: [number, number][], lift = 0): number[] {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(isoX(x, y), isoY(x, y) - lift);
  return out;
}

export function shade(color: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((color & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

/** 座標から決まる疑似乱数 0..1（見た目のばらつき用） */
export function hash01(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
