// 技術点と部品の研究（v0.8.4）
//
// ・技術点は、ふだんの運行でたまる（走っている列車1本につき毎月。自社開発の機関車は2倍）。機関車の完成でも増える
// ・技術点（と少しのお金）で「部品」を研究すると、それからの自社開発がずっと強くなる
//   能力のたまり方・試験の成功率・開発の日数・販売の利益
// ・動力ごとの部品（蒸気・ディーゼル・電気）と、どれにも効く部品がある。年代で研究できるようになる部品もある

import { DEV_POWER_NAMES, type DevPower } from './constants';
import type { DevStat } from './devel';
import { dateOf, pushEvent, spend, type World } from './world';

export interface Part {
  id: string;
  name: string;
  desc: string;
  /** この動力の機関車だけに効く（ないときはどれにも効く） */
  power?: DevPower;
  year?: number;
  /** 技術点とお金 */
  tech: number;
  money: number;
  /** ポイントのたまり方の倍率（＋割合） */
  stats?: Partial<Record<DevStat, number>>;
  /** 試験の成功率（＋） */
  chance?: number;
  /** 開発の日数（−割合） */
  days?: number;
  /** 販売：つくる費用（−。機関車の値段に対する割合） */
  makeCost?: number;
}

export const PARTS: Part[] = [
  { id: 'bogie', name: '改良台車', desc: 'ゆれが少ない台車。快適さ＋15%', tech: 15, money: 5_000_000, stats: { comfort: 0.15 } },
  { id: 'testbed', name: '試験設備', desc: '試運転・高速試験の成功率＋8%', tech: 20, money: 10_000_000, chance: 0.08 },
  { id: 'boiler', name: '高圧ボイラー', desc: '力＋20%・速さ＋10%', power: 'steam', tech: 20, money: 8_000_000, stats: { might: 0.2, speed: 0.1 } },
  { id: 'lightbody', name: '軽量車体', desc: '速さ＋10%・経済性＋10%', year: 1964, tech: 30, money: 15_000_000, stats: { speed: 0.1, economy: 0.1 } },
  { id: 'hydraulic', name: '液体変速機', desc: '経済性＋20%・力＋10%', power: 'diesel', year: 1962, tech: 25, money: 12_000_000, stats: { economy: 0.2, might: 0.1 } },
  { id: 'lab', name: '研究所の拡張', desc: '開発の日数−20%', year: 1966, tech: 40, money: 30_000_000, days: 0.2 },
  { id: 'pantograph', name: '新型パンタグラフ', desc: '速さ＋20%', power: 'electric', year: 1967, tech: 30, money: 15_000_000, stats: { speed: 0.2 } },
  { id: 'massline', name: '量産ライン', desc: '販売の1両の利益が上がる（つくる費用−7%）', year: 1968, tech: 40, money: 40_000_000, makeCost: 0.07 },
  { id: 'turbo', name: 'ターボ過給器', desc: '速さ＋15%・力＋15%', power: 'diesel', year: 1972, tech: 45, money: 25_000_000, stats: { speed: 0.15, might: 0.15 } },
  { id: 'aircon', name: '冷房装置', desc: '快適さ＋25%', year: 1974, tech: 40, money: 20_000_000, stats: { comfort: 0.25 } },
  { id: 'regen', name: '回生ブレーキ', desc: '経済性＋30%', power: 'electric', year: 1976, tech: 50, money: 30_000_000, stats: { economy: 0.3 } },
  { id: 'computer', name: '電子制御', desc: '試験の成功率＋8%・速さ＋10%', year: 1982, tech: 70, money: 50_000_000, chance: 0.08, stats: { speed: 0.1 } },
];

export const TECH = {
  /** 走っている列車1本・1か月あたり */
  perTrain: 0.25,
  /** 自社開発の機関車の列車は、さらにこれだけ */
  devBonus: 0.25,
  /** 機関車が完成したとき */
  onDesign: 5,
  max: 9999,
};

export function hasPart(world: World, id: string): boolean {
  return world.parts?.includes(id) ?? false;
}

function owned(world: World): Part[] {
  return PARTS.filter((p) => hasPart(world, p.id));
}

const applies = (p: Part, power: DevPower) => !p.power || p.power === power;

/** ポイントのたまり方の倍率 */
export function partStatMul(world: World, power: DevPower, stat: DevStat): number {
  let m = 1;
  for (const p of owned(world)) if (applies(p, power)) m += p.stats?.[stat] ?? 0;
  return m;
}

export function partChance(world: World): number {
  return owned(world).reduce((s, p) => s + (p.chance ?? 0), 0);
}

export function partDays(world: World): number {
  return owned(world).reduce((s, p) => s + (p.days ?? 0), 0);
}

export function partMakeCost(world: World): number {
  return owned(world).reduce((s, p) => s + (p.makeCost ?? 0), 0);
}

/** 研究できるか（だめなら理由） */
export function researchError(world: World, id: string): string | null {
  const p = PARTS.find((x) => x.id === id);
  if (!p) return 'その部品はありません';
  if (hasPart(world, id)) return 'もう研究しました';
  if (p.year && dateOf(world.day).y < p.year) return `${p.year}年から研究できます`;
  if ((world.tech ?? 0) < p.tech) return '技術点が足りません';
  if (world.money < p.money) return 'お金が足りません';
  return null;
}

export function research(world: World, id: string): string | null {
  const err = researchError(world, id);
  if (err) return err;
  const p = PARTS.find((x) => x.id === id)!;
  world.tech = (world.tech ?? 0) - p.tech;
  spend(world, 'devel', p.money);
  (world.parts ??= []).push(id);
  world.version++;
  pushEvent(world, { type: 'news', text: `「${p.name}」の研究が終わりました（${p.power ? `${DEV_POWER_NAMES[p.power]}の機関車：` : ''}${p.desc}）`, tone: 'good' });
  return null;
}

/** 1か月にたまる技術点のめやす */
export function techPerMonth(world: World): number {
  let n = 0;
  for (const t of world.trains.values()) {
    if (t.state === 'in_depot') continue;
    n += TECH.perTrain;
    if (/^dev\d+$/.test(t.cars[0]?.type ?? '')) n += TECH.devBonus;
  }
  return n;
}

/** 毎月：運行で技術点がたまる */
export function techMonthly(world: World) {
  const before = world.tech ?? 0;
  world.tech = Math.min(TECH.max, before + techPerMonth(world));
  // はじめて研究できる部品ができたら知らせる
  const ready = PARTS.find((p) => !hasPart(world, p.id) && (!p.year || dateOf(world.day).y >= p.year) && before < p.tech && world.tech! >= p.tech);
  if (ready && (world.designs?.length ?? 0) > 0)
    pushEvent(world, { type: 'news', text: `技術点がたまり、「${ready.name}」を研究できるようになりました（自社開発の画面で）`, tone: 'info' });
}
