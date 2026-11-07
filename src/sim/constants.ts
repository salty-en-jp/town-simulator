// ゲームの定数（バランス調整はここに集約する）

export const TICKS_PER_DAY = 60;
export const DAYS_PER_MONTH = 30; // 表示は実カレンダー、経済処理は30日ごと
export const START_YEAR = 1960;

export type Cargo = 'passengers' | 'logs' | 'lumber';
export const CARGOS: readonly Cargo[] = ['passengers', 'logs', 'lumber'];

export interface CargoSpec {
  name: string;
  unit: string;
  /** 1単位・1マスあたりの基本運賃（円） */
  rate: number;
  /** この日数までは満額 */
  days1: number;
  /** days1 を超えてからこの日数を超えると、減り方が倍になる */
  days2: number;
  color: number;
}

export const CARGO_SPECS: Record<Cargo, CargoSpec> = {
  passengers: { name: '旅客', unit: '人', rate: 160, days1: 4, days2: 20, color: 0x3d7a5a },
  logs: { name: '原木', unit: 't', rate: 420, days1: 30, days2: 60, color: 0x8b5a2b },
  lumber: { name: '木材', unit: 't', rate: 620, days1: 20, days2: 40, color: 0xc69c6d },
};

export type WagonType = 'coach' | 'logcar' | 'lumbercar';

export interface WagonSpec {
  name: string;
  cargo: Cargo;
  capacity: number;
  cost: number;
}

export const WAGON_SPECS: Record<WagonType, WagonSpec> = {
  coach: { name: '客車', cargo: 'passengers', capacity: 40, cost: 1_500_000 },
  logcar: { name: '原木車', cargo: 'logs', capacity: 30, cost: 1_500_000 },
  lumbercar: { name: '木材車', cargo: 'lumber', capacity: 30, cost: 1_500_000 },
};

export const ENGINE = {
  name: 'ツナグ形蒸気機関車',
  cost: 12_000_000,
  /** マス/日 */
  speed: 4,
  /** 年間維持費（月割りで引かれる） */
  runningCostPerYear: 1_500_000,
};

export const MAX_WAGONS = 8;

export const COSTS = {
  trackPerConnection: 200_000,
  trackWaterMultiplier: 5,
  clearTrees: 20_000,
  removeTrackPerConnection: 20_000,
  stationPerTile: 3_000_000,
  depot: 2_000_000,
  demolishHouse: 50_000,
  demolishTile: 20_000,
  demolishStationTile: 300_000,
  demolishDepot: 300_000,
};

export const FINANCE = {
  startMoney: 50_000_000,
  startLoan: 50_000_000,
  maxLoan: 100_000_000,
  loanStep: 5_000_000,
  /** 年利（%） */
  interestRate: 4,
};

export const STATION = {
  catchment: 4,
  maxLength: 6,
  initialRating: 175,
  /** 1両・1日あたりの積み降ろし量 */
  loadPerDay: 24,
};

export const INDUSTRY = {
  forestStartRate: 72, // t/月
  sawmillRate: 120, // 1か月に加工できる最大量
  stockCap: 500,
};

export const TOWN = {
  lumberPerHouse: 10,
  lumberPerUpgrade2: 10,
  lumberPerUpgrade3: 25,
};

export const HOUSE_POP = [0, 8, 30, 80] as const;
export const HOUSE_PAX_PER_DAY = [0, 0.4, 1.5, 4] as const;
