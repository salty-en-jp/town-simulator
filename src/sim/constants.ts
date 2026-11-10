// ゲームの定数（バランス調整はここに集約する）

export const TICKS_PER_DAY = 60;
export const DAYS_PER_MONTH = 30; // 表示は実カレンダー、経済処理は30日ごと
export const START_YEAR = 1960;

export type Cargo =
  | 'passengers'
  | 'logs'
  | 'lumber'
  | 'grain'
  | 'food'
  | 'ore'
  | 'coal'
  | 'steel'
  | 'materials'
  | 'livestock'
  | 'fish';
export const CARGOS: readonly Cargo[] = ['passengers', 'logs', 'lumber', 'grain', 'livestock', 'fish', 'food', 'ore', 'coal', 'steel', 'materials'];
/** 町が受け入れる貨物（旅客以外） */
export const TOWN_GOODS: readonly Cargo[] = ['lumber', 'food', 'materials'];

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
  grain: { name: '穀物', unit: 't', rate: 380, days1: 16, days2: 40, color: 0xe0b84a },
  food: { name: '食料品', unit: 't', rate: 720, days1: 6, days2: 20, color: 0xe9e4d6 },
  ore: { name: '鉄鉱石', unit: 't', rate: 360, days1: 40, days2: 80, color: 0xa0543c },
  coal: { name: '石炭', unit: 't', rate: 340, days1: 40, days2: 80, color: 0x2b2b2e },
  steel: { name: '鋼材', unit: 't', rate: 620, days1: 30, days2: 60, color: 0x8d9aa8 },
  materials: { name: '建設資材', unit: 't', rate: 820, days1: 20, days2: 40, color: 0xd88a3c },
  livestock: { name: '家畜', unit: '頭', rate: 520, days1: 10, days2: 30, color: 0xb88a5a },
  fish: { name: '魚', unit: 't', rate: 600, days1: 5, days2: 15, color: 0x6fa8c8 },
};

export type WagonType =
  | 'coach'
  | 'logcar'
  | 'lumbercar'
  | 'graincar'
  | 'foodcar'
  | 'orecar'
  | 'coalcar'
  | 'steelcar'
  | 'materialcar'
  | 'biglogcar'
  | 'biglumbercar'
  | 'biggraincar'
  | 'freshcar'
  | 'bigcoach'
  | 'bigorecar'
  | 'bigcoalcar'
  | 'bigsteelcar'
  | 'bigmaterialcar'
  | 'livestockcar'
  | 'fishcar';
export type EngineType = 'steam' | 'express' | 'heavy' | 'superexpress';
export type VehicleType = EngineType | WagonType;

export interface WagonSpec {
  name: string;
  cargo: Cargo;
  capacity: number;
  cost: number;
  /** 登場する年（それまでは買えない。依頼の報酬で早めに使えることもある） */
  year?: number;
  /** 荷物の傷み方（1 がふつう。0.5 なら半分の速さでしか日数が進まない） */
  fresh?: number;
  /** 大型（見た目が少し大きい） */
  big?: boolean;
}

export interface EngineSpec {
  name: string;
  cost: number;
  /** マス/日 */
  speed: number;
  /** 年間維持費（走っているときだけ。月割りで引かれる） */
  runningCostPerYear: number;
  /** つなげる車両（機関車をのぞく）の両数の上限 */
  maxCars: number;
  /** つなげられる車両：なんでも／客車だけ／貨車だけ */
  allow: 'any' | 'pax' | 'freight';
  year?: number;
  desc: string;
}

// 登場の順番は「田舎に必要なもの」から：原木・木材・穀物・食料品 → 貨物用機関車・旅客 → 重工業 → 超特急
export const WAGON_SPECS: Record<WagonType, WagonSpec> = {
  coach: { name: '客車', cargo: 'passengers', capacity: 40, cost: 1_500_000 },
  logcar: { name: '原木車', cargo: 'logs', capacity: 30, cost: 1_500_000 },
  lumbercar: { name: '木材車', cargo: 'lumber', capacity: 30, cost: 1_500_000 },
  graincar: { name: '穀物車', cargo: 'grain', capacity: 30, cost: 1_500_000 },
  foodcar: { name: '冷蔵車', cargo: 'food', capacity: 25, cost: 1_800_000 },
  orecar: { name: '鉱石車', cargo: 'ore', capacity: 35, cost: 1_600_000 },
  coalcar: { name: '石炭車', cargo: 'coal', capacity: 35, cost: 1_600_000 },
  steelcar: { name: '鋼材車', cargo: 'steel', capacity: 30, cost: 1_700_000 },
  materialcar: { name: '資材車', cargo: 'materials', capacity: 25, cost: 1_800_000 },
  biglogcar: { name: '大型原木車', cargo: 'logs', capacity: 45, cost: 2_200_000, year: 1962, big: true },
  biglumbercar: { name: '大型木材車', cargo: 'lumber', capacity: 45, cost: 2_200_000, year: 1963, big: true },
  biggraincar: { name: '大型穀物車', cargo: 'grain', capacity: 45, cost: 2_200_000, year: 1964, big: true },
  freshcar: { name: '新型冷蔵車', cargo: 'food', capacity: 30, cost: 2_600_000, year: 1966, fresh: 0.5, big: true },
  bigcoach: { name: '大型客車', cargo: 'passengers', capacity: 60, cost: 2_400_000, year: 1970, big: true },
  bigorecar: { name: '大型鉱石車', cargo: 'ore', capacity: 50, cost: 2_400_000, year: 1974, big: true },
  bigcoalcar: { name: '大型石炭車', cargo: 'coal', capacity: 50, cost: 2_400_000, year: 1974, big: true },
  bigsteelcar: { name: '大型鋼材車', cargo: 'steel', capacity: 45, cost: 2_600_000, year: 1977, big: true },
  bigmaterialcar: { name: '大型資材車', cargo: 'materials', capacity: 40, cost: 2_800_000, year: 1977, big: true },
  livestockcar: { name: '家畜車', cargo: 'livestock', capacity: 20, cost: 1_600_000 },
  fishcar: { name: '魚の冷蔵車', cargo: 'fish', capacity: 25, cost: 2_000_000, fresh: 0.6 },
};

export const ENGINE_SPECS: Record<EngineType, EngineSpec> = {
  steam: { name: 'ツナグ形蒸気機関車', cost: 12_000_000, speed: 4, runningCostPerYear: 1_500_000, maxCars: 8, allow: 'any', desc: 'なんでも引ける' },
  heavy: {
    name: 'ゴウリキ形貨物機関車',
    cost: 18_000_000,
    speed: 3.5,
    runningCostPerYear: 2_000_000,
    maxCars: 14,
    allow: 'freight',
    year: 1968,
    desc: '遅いが力持ち。貨車だけ',
  },
  express: { name: 'ハヤテ形機関車', cost: 20_000_000, speed: 5.5, runningCostPerYear: 2_200_000, maxCars: 10, allow: 'any', year: 1972, desc: '速い。なんでも引ける' },
  superexpress: {
    name: 'ツバサ形超特急',
    cost: 38_000_000,
    speed: 8,
    runningCostPerYear: 4_000_000,
    maxCars: 12,
    allow: 'pax',
    year: 1982,
    desc: 'とても速い。客車だけ',
  },
};

export const ENGINE_TYPES = Object.keys(ENGINE_SPECS) as EngineType[];
export const WAGON_TYPES = Object.keys(WAGON_SPECS) as WagonType[];

export function isEngine(t: VehicleType): t is EngineType {
  return t in ENGINE_SPECS;
}

export function vehicleName(t: VehicleType): string {
  return isEngine(t) ? ENGINE_SPECS[t].name : WAGON_SPECS[t].name;
}

export function vehicleCost(t: VehicleType): number {
  return isEngine(t) ? ENGINE_SPECS[t].cost : WAGON_SPECS[t].cost;
}

/** 年数による売値：新品は 75%、15年で 25% まで下がる */
export function vehicleValue(t: VehicleType, ageDays: number): number {
  const years = ageDays / 365;
  const f = Math.max(0.25, 0.75 - (0.5 * years) / 15);
  return Math.round(vehicleCost(t) * f);
}

export const MAX_WAGONS = 8;

export const COSTS = {
  trackPerConnection: 200_000,
  trackWaterMultiplier: 5,
  /** 山地の岩場に線路を引くときの倍率 */
  trackRockMultiplier: 2.5,
  clearTrees: 20_000,
  removeTrackPerConnection: 20_000,
  stationPerTile: 3_000_000,
  depot: 2_000_000,
  /** 車庫代（1か所・1年あたり）。留置線の車両は維持費がかからない */
  depotPerYear: 600_000,
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
  /** 入力・出力の在庫の上限（t） */
  stockCap: 500,
};

export type IndustryType =
  | 'forest'
  | 'farm'
  | 'ironmine'
  | 'coalmine'
  | 'sawmill'
  | 'foodplant'
  | 'steelmill'
  | 'materialsplant'
  | 'ranch'
  | 'fishery';

export interface IndustrySpec {
  /** 名前の後ろ（「桜川」＋「製材所」） */
  suffix: string;
  /** 受け入れる貨物。2つ以上あるときは、全部そろって初めてフル生産（anyInput なら、どれか1つで動く） */
  inputs: Cargo[];
  /** 材料はどれか1つでよい（食品工場：穀物・家畜・魚） */
  anyInput?: boolean;
  output: Cargo;
  /** 一次産業：1か月の生産量。加工：1か月に加工できる最大量 */
  rate: number;
  w: number;
  h: number;
  desc: string;
}

export const INDUSTRY_SPECS: Record<IndustryType, IndustrySpec> = {
  forest: { suffix: 'の森', inputs: [], output: 'logs', rate: 72, w: 3, h: 3, desc: '原木を生産する森です。' },
  farm: { suffix: '農場', inputs: [], output: 'grain', rate: 80, w: 3, h: 3, desc: '穀物を生産する農場です。' },
  ironmine: { suffix: '鉄鉱山', inputs: [], output: 'ore', rate: 90, w: 2, h: 2, desc: '鉄鉱石を掘り出す鉱山です。' },
  coalmine: { suffix: '炭鉱', inputs: [], output: 'coal', rate: 90, w: 2, h: 2, desc: '石炭を掘り出す炭鉱です。' },
  sawmill: { suffix: '製材所', inputs: ['logs'], output: 'lumber', rate: 120, w: 3, h: 2, desc: '原木を木材に加工します。' },
  foodplant: {
    suffix: '食品工場',
    inputs: ['grain', 'livestock', 'fish'],
    anyInput: true,
    output: 'food',
    rate: 120,
    w: 3,
    h: 2,
    desc: '穀物・家畜・魚のどれからでも食料品をつくります。食料品を町に届けると、町が早く育ちます。',
  },
  ranch: { suffix: '牧場', inputs: [], output: 'livestock', rate: 60, w: 3, h: 3, desc: '家畜を育てる牧場です。山すその田舎に多くあります。' },
  fishery: { suffix: '漁港', inputs: [], output: 'fish', rate: 70, w: 2, h: 2, desc: '魚がとれる漁港です。海のそばにあります。魚は傷みやすいので、早く運びましょう。' },
  steelmill: {
    suffix: '製鉄所',
    inputs: ['ore', 'coal'],
    output: 'steel',
    rate: 120,
    w: 3,
    h: 3,
    desc: '鉄鉱石と石炭から鋼材をつくります。両方がそろわないと動きません。',
  },
  materialsplant: {
    suffix: '建材工場',
    inputs: ['lumber', 'steel'],
    output: 'materials',
    rate: 100,
    w: 3,
    h: 2,
    desc: '木材と鋼材から建設資材をつくります。建設資材を町に届けると高層ビルが建ちます。',
  },
};

export const INDUSTRY_TYPES = Object.keys(INDUSTRY_SPECS) as IndustryType[];
export const PRIMARY_TYPES: IndustryType[] = ['forest', 'farm', 'ironmine', 'coalmine', 'ranch', 'fishery'];
export const FACTORY_TYPES: IndustryType[] = ['sawmill', 'foodplant', 'steelmill', 'materialsplant'];

/** 産業の持ち主・権利・契約・探鉱・建設 */
export const INDUSTRY_ECON = {
  /** 一次産業の権利の値段：1か月の生産量 1t あたり */
  pricePerMonthlyT: 150_000,
  /** 工場の値段（建設費・権利の値段） */
  factoryPrice: { sawmill: 25_000_000, foodplant: 30_000_000, steelmill: 50_000_000, materialsplant: 45_000_000 } as Record<
    string,
    number
  >,
  /** 工場の建設にかかる日数 */
  buildDays: 60,
  /** 探鉱の費用と、調査にかかる日数 */
  surveyCost: { forest: 8_000_000, farm: 10_000_000, ironmine: 15_000_000, coalmine: 15_000_000, ranch: 9_000_000, fishery: 12_000_000 } as Record<string, number>,
  surveyDays: 60,
  /** 自社の産業の配当：運び出した製品 1t あたり ＝ 貨物の基本運賃 × この倍率 */
  dividendRateMul: 6,
  /** 自社の産業の維持費（1年あたり、値段に対する割合） */
  upkeepPerYear: 0.03,
  /** 増産：値段のこの割合を払うと、生産量（加工能力）が expandFactor 倍 */
  expandCostRatio: 0.5,
  expandFactor: 1.25,
  /** 輸送契約：料金（値段に対する割合）・期間・条件 */
  contractFeeRatio: 0.06,
  contractDays: 730,
  /** 毎月これだけの割合を運び出すこと（はじめの contractGraceDays 日は数えない） */
  contractMinRate: 0.4,
  contractGraceDays: 60,
  /** 条件を守れなかった月がこれだけ続くと、契約が打ち切られる */
  contractMaxStrikes: 3,
  /** 毎月、他社の一次産業が新しく見つかる確率 */
  discoverPerMonth: 1 / 15,
  maxIndustries: 30,
};

export const TOWN = {
  lumberPerHouse: 10,
  lumberPerUpgrade2: 10,
  /** 高層ビル（ランク3）への建て替えに使う建設資材 */
  materialsPerUpgrade3: 20,
  /** 町が貯めておける貨物の量（多いほど買取価格が下がる） */
  stockCap: 300,
  /** 1日に人口1,000人あたりで食べる食料品（t） */
  foodPerThousand: 3,
};

export const HOUSE_POP = [0, 8, 30, 80] as const;
export const HOUSE_PAX_PER_DAY = [0, 0.4, 1.5, 4] as const;
