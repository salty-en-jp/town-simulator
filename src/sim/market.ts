// 相場とブーム（v0.5.5）
//
// ・相場：貨物ごとの値段の目安が、毎月ゆっくり上下する（×0.75〜×1.3）
// ・ブーム：期間限定で「どこで・何が・何倍」高く売れる。気づいて運び先や振り分けを変えた人が得をする
//   - 建設ラッシュ：町で木材か建設資材が高く売れる
//   - 復興需要：火事のあと、その町で木材と建設資材が高く売れる
//   - 材料不足：工場で材料が高く売れる
//   - 観光ブーム：小さな町へ行く旅客の運賃が上がり、その町の旅客も増える
// 方針：プレイヤーの持ち物に損害は出さない。手をかけた人がもっと得をする形にする

import { CARGO_SPECS, CARGOS, INDUSTRY_SPECS, type Cargo } from './constants';
import { townAccepts } from './towns';
import { idx, isPrimary, paceMul, pushEvent, townLabel, type World } from './world';

export type BoomKind = 'rush' | 'rebuild' | 'shortage' | 'tourism';

export interface Boom {
  id: number;
  kind: BoomKind;
  target: { kind: 'town' | 'industry'; id: number };
  cargo: Cargo;
  /** 買取の倍率 */
  mul: number;
  from: number;
  until: number;
}

export const MARKET = {
  min: 0.75,
  max: 1.3,
  /** 毎月の揺れの大きさと、1 に戻ろうとする強さ */
  step: 0.07,
  pull: 0.12,
  maxBooms: 4,
  /** 毎月、新しいブームが起きる確率（種類ごと） */
  rushChance: 1 / 8,
  shortageChance: 1 / 8,
  tourismChance: 1 / 10,
  /** 観光ブームが起きる町の大きさの上限（人） */
  tourismMaxPop: 1000,
  tourismPaxMul: 1.5,
  rebuildDays: 120,
};

export const BOOM_LABEL: Record<BoomKind, string> = {
  rush: '建設ラッシュ',
  rebuild: '復興需要',
  shortage: '材料不足',
  tourism: '観光ブーム',
};

/** 貨物の相場（旅客は 1） */
export function marketIndex(world: World, cargo: Cargo): number {
  if (cargo === 'passengers') return 1;
  return world.market?.[cargo] ?? 1;
}

export function activeBooms(world: World): Boom[] {
  return (world.booms ?? []).filter((b) => b.until > world.day);
}

/** ブームによる倍率（重なったら掛け合わせ） */
export function boomMul(world: World, target: { kind: 'town' | 'industry'; id: number }, cargo: Cargo): number {
  let m = 1;
  for (const b of world.booms ?? []) {
    if (b.until > world.day && b.cargo === cargo && b.target.kind === target.kind && b.target.id === target.id) m *= b.mul;
  }
  return m;
}

/** 町が観光ブームのときの旅客の増え方 */
export function tourismPaxMul(world: World, townId: number): number {
  return (world.booms ?? []).some((b) => b.kind === 'tourism' && b.target.id === townId && b.until > world.day) ? MARKET.tourismPaxMul : 1;
}

export function boomPlace(world: World, b: Boom): string {
  if (b.target.kind === 'town') {
    const t = world.towns.get(b.target.id);
    return t ? townLabel(t) : '';
  }
  return world.industries.get(b.target.id)?.name ?? '';
}

export function boomTile(world: World, b: Boom): number {
  if (b.target.kind === 'town') {
    const t = world.towns.get(b.target.id);
    return t ? idx(world, t.cx, t.cy) : -1;
  }
  const ind = world.industries.get(b.target.id);
  return ind ? idx(world, ind.x, ind.y) : -1;
}

export function boomText(world: World, b: Boom): string {
  const place = boomPlace(world, b);
  const cargo = CARGO_SPECS[b.cargo].name;
  const mul = `×${b.mul.toFixed(1)}`;
  switch (b.kind) {
    case 'rush':
      return `${place}で建設ラッシュ！ ${cargo}が高く売れます（${mul}）`;
    case 'rebuild':
      return `${place}で火事からの復興がはじまりました。${cargo}が高く売れます（${mul}）`;
    case 'shortage':
      return `${place}で材料が足りません。${cargo}が高く売れます（${mul}）`;
    case 'tourism':
      return `${place}で観光ブーム！ この町へ来る旅客の運賃が上がり、旅客も増えます（${mul}）`;
  }
}

/** ブームを始める。同じ場所・同じ貨物のブームがあれば、長い方・強い方にまとめる */
export function startBoom(world: World, kind: BoomKind, target: Boom['target'], cargo: Cargo, mul: number, days: number, news = true): Boom {
  world.booms ??= [];
  const same = world.booms.find((b) => b.until > world.day && b.cargo === cargo && b.target.kind === target.kind && b.target.id === target.id);
  if (same) {
    same.until = Math.max(same.until, world.day + days);
    same.mul = Math.max(same.mul, mul);
    return same;
  }
  const b: Boom = { id: world.nextId++, kind, target, cargo, mul, from: world.day, until: world.day + days };
  world.booms.push(b);
  if (news) pushEvent(world, { type: 'news', text: boomText(world, b), tone: 'good', tile: boomTile(world, b) });
  return b;
}

/** 火事のあと：その町で木材と建設資材が高く売れる */
export function startRebuild(world: World, townId: number, burned: number) {
  const mul = Math.min(2, 1.4 + burned * 0.1);
  const town = world.towns.get(townId);
  if (!town) return;
  // 都市（建設資材だけを受け入れる町）なら建設資材だけ。そうでなければ木材も
  const cargos = (['lumber', 'materials'] as Cargo[]).filter((c) => townAccepts(world, townId, c));
  for (const c of cargos) startBoom(world, 'rebuild', { kind: 'town', id: townId }, c, mul, Math.round(MARKET.rebuildDays / paceMul(world)), false);
  pushEvent(world, {
    type: 'news',
    text: `${townLabel(town)}で復興がはじまります。しばらく${cargos.map((c) => CARGO_SPECS[c].name).join('と')}が高く売れます（×${mul.toFixed(1)}）`,
    tone: 'good',
    tile: idx(world, town.cx, town.cy),
  });
}

/** 毎月：相場を動かし、ブームを始めたり終えたりする */
export function marketMonthly(world: World) {
  world.market ??= {};
  // 時間の流れ：目まぐるしいほど、相場がよく動き、ブームがよく来て早く終わる
  const p = paceMul(world);
  for (const c of CARGOS) {
    if (c === 'passengers') continue;
    const v = world.market[c] ?? 1;
    const before = v;
    let next = v * (1 + (world.rng.next() * 2 - 1) * MARKET.step * p);
    next += (1 - next) * MARKET.pull;
    next = Math.min(MARKET.max, Math.max(MARKET.min, next));
    world.market[c] = Math.round(next * 1000) / 1000;
    if (before < 1.15 && next >= 1.15)
      pushEvent(world, { type: 'news', text: `${CARGO_SPECS[c].name}の相場が上がっています（×${next.toFixed(2)}）`, tone: 'good' });
    if (before > 0.85 && next <= 0.85) pushEvent(world, { type: 'news', text: `${CARGO_SPECS[c].name}の相場が下がっています（×${next.toFixed(2)}）`, tone: 'info' });
  }

  // 終わったブーム
  for (const b of world.booms ?? []) {
    if (b.until <= world.day && b.until > world.day - 31) {
      pushEvent(world, { type: 'news', text: `${boomPlace(world, b)}の${BOOM_LABEL[b.kind]}が終わりました`, tone: 'info', tile: boomTile(world, b) });
    }
  }
  world.booms = (world.booms ?? []).filter((b) => b.until > world.day);

  const room = () => world.booms!.length < MARKET.maxBooms;
  const towns = [...world.towns.values()];
  if (room() && towns.length && world.rng.chance(MARKET.rushChance * p)) {
    const big = towns.filter((t) => t.population >= 300);
    if (big.length) {
      const t = world.rng.pick(big);
      const cargos = (['lumber', 'materials'] as Cargo[]).filter((c) => townAccepts(world, t.id, c));
      if (cargos.length) startBoom(world, 'rush', { kind: 'town', id: t.id }, world.rng.pick(cargos), 1.6 + world.rng.next() * 0.4, Math.round((150 + Math.floor(world.rng.next() * 60)) / p));
    }
  }
  if (room() && world.rng.chance(MARKET.shortageChance * p)) {
    const factories = [...world.industries.values()].filter((i) => !isPrimary(i.type) && i.status === 'active');
    if (factories.length) {
      const ind = world.rng.pick(factories);
      const input = world.rng.pick(INDUSTRY_SPECS[ind.type].inputs);
      startBoom(world, 'shortage', { kind: 'industry', id: ind.id }, input, 1.5 + world.rng.next() * 0.3, Math.round((90 + Math.floor(world.rng.next() * 60)) / p));
    }
  }
  if (room() && world.rng.chance(MARKET.tourismChance * p)) {
    const small = towns.filter((t) => t.population < MARKET.tourismMaxPop);
    if (small.length && towns.length >= 2) {
      const t = world.rng.pick(small);
      startBoom(world, 'tourism', { kind: 'town', id: t.id }, 'passengers', 2, Math.round(180 / p));
    }
  }
}
