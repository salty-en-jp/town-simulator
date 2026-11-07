// 運賃の計算（OpenTTD の「決まった日数までは満額 → 段階的に減る」考え方を参考にした独自実装）

import { CARGO_SPECS, INDUSTRY, type Cargo } from './constants';

const MAX_FACTOR = 255;
const MIN_FACTOR = 31;

/** 輸送日数による係数 0..1 */
export function timeFactor(days: number, days1: number, days2: number): number {
  const over1 = Math.max(0, days - days1);
  const over2 = Math.max(0, over1 - days2);
  const f = Math.max(MIN_FACTOR, MAX_FACTOR - over1 - over2);
  return f / MAX_FACTOR;
}

/**
 * 届け先の在庫による需要係数（在庫が少ないほど高く買ってくれる）
 * 在庫ゼロ → 1.8、在庫が上限 → 0.5
 */
export function demandFactor(stock: number, cap = INDUSTRY.stockCap): number {
  const r = Math.min(1, Math.max(0, stock / cap));
  return 1.8 - 1.3 * r;
}

/** 受取額 = 量 × 距離 × 単価 × 時間係数 × 需要係数 */
export function cargoIncome(
  cargo: Cargo,
  amount: number,
  distance: number,
  days: number,
  demand = 1,
): number {
  const spec = CARGO_SPECS[cargo];
  return Math.round(amount * distance * spec.rate * timeFactor(days, spec.days1, spec.days2) * demand);
}
