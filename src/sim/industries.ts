// 産業の持ち主・権利・輸送契約・探鉱・工場の建設
//
// ・他社（other）の産業からは、権利を買うか輸送契約を結ばないと貨物を運び出せない
//   （届けて売るのは、どの工場にもできる）
// ・自社（player）の産業は、運び出した量に応じて毎月配当が入り、維持費がかかる
// ・一次産業は、ときどき自然に見つかる（他社）。お金を出して探鉱もできる（成功すれば自社）
// ・工場はプレイヤーが建てられる（建設期間のあと動き出す）

import {
  CARGO_SPECS,
  INDUSTRY_ECON,
  INDUSTRY_SPECS,
  PRIMARY_TYPES,
  type IndustryType,
} from './constants';
import type { CmdResult } from './commands';
import {
  canLoadFrom,
  earn,
  idx,
  inBounds,
  industryValue,
  isPrimary,
  newId,
  pushEvent,
  spend,
  Terrain,
  type Industry,
  type IndustryOwner,
  type World,
  paceMul,
} from './world';

const E = INDUSTRY_ECON;

function yen(v: number): string {
  const a = Math.round(v / 10_000);
  return a >= 10_000 ? `¥${Math.floor(a / 10_000)}億${a % 10_000 ? `${(a % 10_000).toLocaleString('ja-JP')}万` : ''}` : `¥${a.toLocaleString('ja-JP')}万`;
}

const fail = (error: string, cost = 0): CmdResult => ({ ok: false, cost, error });

// ───────────────────────── 配置 ─────────────────────────

function clearArea(world: World, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (inBounds(world, x, y)) world.terrain[idx(world, x, y)] = Terrain.Grass;
    }
  }
}

/** いちばん近い町の名前を使って産業の名前をつける（重なったら次に近い町、それでもだめなら番号） */
export function industryName(world: World, type: IndustryType, cx: number, cy: number): string {
  const suffix = INDUSTRY_SPECS[type].suffix;
  const taken = new Set([...world.industries.values()].map((i) => i.name));
  const towns = [...world.towns.values()].sort(
    (a, b) => Math.abs(a.cx - cx) + Math.abs(a.cy - cy) - (Math.abs(b.cx - cx) + Math.abs(b.cy - cy)),
  );
  for (const t of towns) if (!taken.has(`${t.name}${suffix}`)) return `${t.name}${suffix}`;
  const base = towns[0]?.name ?? 'ツナグ';
  for (let n = 2; ; n++) if (!taken.has(`${base}第${n}${suffix}`)) return `${base}第${n}${suffix}`;
}

/**
 * 置けるか：まわり1マスも含めて水・建物・線路がない。
 * spacing が true のときは、ほかの産業・町からも離す（マップ生成・自然発見用）
 */
export function canPlaceIndustry(world: World, type: IndustryType, x: number, y: number, spacing: boolean): string | null {
  const { w, h } = INDUSTRY_SPECS[type];
  if (x < 1 || y < 1 || x + w + 1 > world.w || y + h + 1 > world.h) return 'マップの端すぎます';
  for (let yy = y - 1; yy <= y + h; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const t = idx(world, xx, yy);
      const inside = xx >= x && xx < x + w && yy >= y && yy < y + h;
      // 漁港と港だけは水辺に置ける（建物の下は陸地）
      const shore = type === 'fishery' || type === 'port';
      if (world.terrain[t] === Terrain.Water && (!shore || inside)) return shore ? '水の上には置けません' : '水の近くには置けません';
      if (inside && world.occ[t]) return '建物があります';
      if (inside && world.track[t]) return '線路があります';
      if (!inside && world.occ[t]?.k === 'industry') return 'ほかの産業と近すぎます';
    }
  }
  if (world.surveys.some((s) => Math.abs(s.x - x) < 4 && Math.abs(s.y - y) < 4)) return '調査中の場所と重なります';
  if (type === 'fishery' && waterAround(world, x, y, w, h) < 8) return '漁港は、広い水辺（海）のそばに置いてください';
  if (type === 'port' && waterAround(world, x, y, w, h) < 12) return '港は、広い海のそばに置いてください';
  if (!spacing) return null;
  const cx = x + w / 2,
    cy = y + h / 2;
  for (const ind of world.industries.values()) {
    if (Math.abs(ind.x + ind.w / 2 - cx) + Math.abs(ind.y + ind.h / 2 - cy) < 14) return 'ほかの産業と近すぎます';
  }
  for (const t of world.towns.values()) {
    if (Math.abs(t.cx - cx) + Math.abs(t.cy - cy) < 10) return '町と近すぎます';
  }
  return null;
}

export function addIndustry(
  world: World,
  type: IndustryType,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  owner: IndustryOwner = 'public',
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
    owner,
    contractUntil: 0,
    contractFrom: 0,
    contractStrikes: 0,
    status: 'active',
    readyDay: 0,
    dividendThisMonth: 0,
    dividendLastMonth: 0,
    expansions: 0,
    hist: { p: [], t: [], r: [] },
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
  world.version++;
  return ind;
}

export function placeIndustryAt(world: World, type: IndustryType, x: number, y: number, owner: IndustryOwner): Industry {
  const spec = INDUSTRY_SPECS[type];
  return addIndustry(world, type, industryName(world, type, x, y), x, y, spec.w, spec.h, owner);
}

/** 空いている場所に、間隔をあけて置く */
export function placeIndustrySomewhere(world: World, type: IndustryType, owner: IndustryOwner): Industry | null {
  // はじめは「その産業に向いた土地」だけを探し、見つからなければどこでも
  const hasRock = world.terrain.includes(Terrain.Rock);
  for (let tries = 0; tries < 600; tries++) {
    const x = world.rng.int(2, world.w - 6),
      y = world.rng.int(2, world.h - 6);
    if (tries < 400 && !suitsLand(world, type, x, y, hasRock)) continue;
    if (!canPlaceIndustry(world, type, x, y, true)) return placeIndustryAt(world, type, x, y, owner);
  }
  return null;
}

/** 産業のまわりの水のマス数（漁港用） */
export function waterAround(world: World, x: number, y: number, w: number, h: number, r = 2): number {
  let n = 0;
  for (let yy = y - r; yy < y + h + r; yy++)
    for (let xx = x - r; xx < x + w + r; xx++) if (xx >= 0 && yy >= 0 && xx < world.w && yy < world.h && world.terrain[idx(world, xx, yy)] === Terrain.Water) n++;
  return n;
}

/** まわりの岩場の割合（0..1） */
export function rockRatio(world: World, cx: number, cy: number, r: number): number {
  let n = 0,
    all = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
      all++;
      if (world.terrain[idx(world, x, y)] === Terrain.Rock) n++;
    }
  return all ? n / all : 0;
}

/** その産業に向いた土地か（鉱山は山地、農場は平野、牧場は山すそ、漁港は海辺） */
function suitsLand(world: World, type: IndustryType, x: number, y: number, hasRock: boolean): boolean {
  const rr = rockRatio(world, x + 1, y + 1, 4);
  switch (type) {
    case 'ironmine':
    case 'coalmine':
      return !hasRock || rr > 0.3;
    case 'farm':
      return rr < 0.05;
    case 'ranch':
      return !hasRock || (rr > 0.05 && rr < 0.5);
    case 'forest':
      return rr < 0.4;
    default:
      return rr < 0.2;
  }
}

// ───────────────────────── 権利・契約・増産 ─────────────────────────

export function rightsPrice(ind: Industry): number {
  return industryValue(ind);
}

export function contractFee(ind: Industry): number {
  return Math.round((industryValue(ind) * E.contractFeeRatio) / 100_000) * 100_000;
}

export function expandCost(ind: Industry): number {
  return Math.round((industryValue(ind) * E.expandCostRatio) / 100_000) * 100_000;
}

export function upkeepPerMonth(ind: Industry): number {
  return Math.round((industryValue(ind) * E.upkeepPerYear) / 12);
}

/** 権利を買って自社の産業にする（他社・地元の産業） */
export function buyRights(world: World, id: number, opts: { dry?: boolean } = {}): CmdResult {
  const ind = world.industries.get(id);
  if (!ind) return fail('産業がありません');
  if (INDUSTRY_SPECS[ind.type].partner) return fail('取引先の施設です（いまは買い取れません）');
  if (ind.owner === 'player') return fail('もう自社の産業です');
  if (ind.status !== 'active') return fail('建設中です');
  const cost = rightsPrice(ind);
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${yen(cost)} 必要）`, cost);
  spend(world, 'industry', cost);
  ind.owner = 'player';
  ind.contractUntil = 0;
  ind.contractStrikes = 0;
  world.version++;
  pushEvent(world, { type: 'news', text: `${ind.name}の権利を買いました。これからは自社の産業です`, tone: 'good', tile: idx(world, ind.x, ind.y) });
  return { ok: true, cost };
}

/** 他社の産業と輸送契約を結ぶ（期限内なら更新） */
export function signContract(world: World, id: number, opts: { dry?: boolean } = {}): CmdResult {
  const ind = world.industries.get(id);
  if (!ind) return fail('産業がありません');
  if (INDUSTRY_SPECS[ind.type].partner) return fail('取引先の施設です（いまは買い取れません）');
  if (ind.owner !== 'other') return fail('契約は他社の産業とだけ結べます');
  if (ind.status !== 'active') return fail('建設中です');
  if (ind.contractUntil - world.day > 180) return fail('契約の更新は、残り180日を切ってからできます');
  const cost = contractFee(ind);
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${yen(cost)} 必要）`, cost);
  spend(world, 'industry', cost);
  const renew = ind.contractUntil > world.day;
  if (!renew) {
    ind.contractFrom = world.day;
    ind.contractStrikes = 0;
  }
  ind.contractUntil = Math.max(ind.contractUntil, world.day) + E.contractDays;
  world.version++;
  pushEvent(world, {
    type: 'news',
    text: `${ind.name}と輸送契約を${renew ? '更新' : '結び'}ました（${Math.round(E.contractDays / 365)}年）`,
    tone: 'good',
    tile: idx(world, ind.x, ind.y),
  });
  return { ok: true, cost };
}

/** 自社の産業を増産する（一次産業は生産量、工場は加工能力） */
export function expandIndustry(world: World, id: number, opts: { dry?: boolean } = {}): CmdResult {
  const ind = world.industries.get(id);
  if (!ind) return fail('産業がありません');
  if (INDUSTRY_SPECS[ind.type].partner) return fail('取引先の施設です（いまは買い取れません）');
  if (ind.owner !== 'player') return fail('増産できるのは自社の産業だけです');
  if (ind.status !== 'active') return fail('建設中です');
  if (ind.prodRate >= 400) return fail('これ以上は増産できません');
  const cost = expandCost(ind);
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${yen(cost)} 必要）`, cost);
  spend(world, 'industry', cost);
  ind.prodRate = Math.round(ind.prodRate * E.expandFactor);
  ind.expansions++;
  pushEvent(world, { type: 'news', text: `${ind.name}を増産しました（月${ind.prodRate}t）`, tone: 'good', tile: idx(world, ind.x, ind.y) });
  return { ok: true, cost };
}

// ───────────────────────── 探鉱・工場の建設 ─────────────────────────

/** 周りの木の割合（0..1） */
export function treeRatio(world: World, x: number, y: number, r: number): number {
  let n = 0,
    trees = 0;
  for (let yy = y - r; yy <= y + r; yy++) {
    for (let xx = x - r; xx <= x + r; xx++) {
      if (!inBounds(world, xx, yy)) continue;
      n++;
      if (world.terrain[idx(world, xx, yy)] === Terrain.Trees) trees++;
    }
  }
  return n ? trees / n : 0;
}

/** 探鉱の成功率（場所で変わる：森は木の多い所、農場は開けた所、鉱山は同じ種類が近くにない所） */
export function surveyChance(world: World, type: IndustryType, x: number, y: number): number {
  const tr = treeRatio(world, x + 1, y + 1, 4);
  let c: number;
  switch (type) {
    case 'forest':
      c = 0.25 + tr * 0.9;
      break;
    case 'farm':
      c = 0.7 - tr * 0.6 - rockRatio(world, x + 1, y + 1, 4);
      break;
    case 'ranch':
      c = 0.55 + Math.min(0.25, rockRatio(world, x + 1, y + 1, 5));
      break;
    case 'fishery':
      c = 0.3 + Math.min(0.5, waterAround(world, x, y, 2, 2, 3) / 40);
      break;
    default: {
      c = (type === 'ironmine' ? 0.4 : 0.45) + rockRatio(world, x + 1, y + 1, 4) * 0.4;
      const same = [...world.industries.values()].some((i) => i.type === type && Math.abs(i.x - x) + Math.abs(i.y - y) < 16);
      if (same) c -= 0.2;
    }
  }
  return Math.max(0.1, Math.min(0.9, c));
}

/** 探鉱をはじめる（調査期間のあと、成功すれば自社の産業ができる。失敗したら費用はもどらない） */
export function startSurvey(world: World, type: IndustryType, x: number, y: number, opts: { dry?: boolean } = {}): CmdResult & { chance?: number } {
  if (!PRIMARY_TYPES.includes(type)) return fail('探鉱できるのは一次産業だけです');
  const err = canPlaceIndustry(world, type, x, y, false);
  if (err) return fail(err);
  const cost = E.surveyCost[type];
  const chance = surveyChance(world, type, x, y);
  if (opts.dry) return { ok: true, cost, chance };
  if (cost > world.money) return fail(`資金が足りません（${yen(cost)} 必要）`, cost);
  spend(world, 'industry', cost);
  world.surveys.push({ id: newId(world), type, x, y, doneDay: world.day + E.surveyDays, chance, roll: world.rng.next(), cost });
  world.version++;
  return { ok: true, cost, chance };
}

/** 工場を建てる（建設期間のあと動き出す） */
export function buildFactory(world: World, type: IndustryType, x: number, y: number, opts: { dry?: boolean } = {}): CmdResult {
  if (INDUSTRY_SPECS[type].partner) return fail('この施設は建てられません');
  if (isPrimary(type)) return fail('一次産業は探鉱で手に入れます');
  const err = canPlaceIndustry(world, type, x, y, false);
  if (err) return fail(err);
  const cost = E.factoryPrice[type];
  if (opts.dry) return { ok: true, cost };
  if (cost > world.money) return fail(`資金が足りません（${yen(cost)} 必要）`, cost);
  spend(world, 'industry', cost);
  const ind = placeIndustryAt(world, type, x, y, 'player');
  ind.status = 'building';
  ind.readyDay = world.day + E.buildDays;
  pushEvent(world, { type: 'news', text: `${ind.name}の建設をはじめました（${E.buildDays}日で完成）`, tone: 'info', tile: idx(world, ind.x, ind.y) });
  return { ok: true, cost, id: ind.id };
}

// ───────────────────────── 毎日・毎月 ─────────────────────────

export function industriesOwnershipDaily(world: World) {
  // 工場の完成
  for (const ind of world.industries.values()) {
    if (ind.status === 'building' && world.day >= ind.readyDay) {
      ind.status = 'active';
      world.version++;
      pushEvent(world, { type: 'news', text: `${ind.name}が完成しました！`, tone: 'good', tile: idx(world, ind.x, ind.y) });
    }
  }
  // 探鉱の結果（終わった調査を先に一覧から外してから置く。自分自身と重ならないように）
  const done = world.surveys.filter((s) => world.day >= s.doneDay);
  if (!done.length) return;
  world.surveys = world.surveys.filter((s) => world.day < s.doneDay);
  world.version++;
  for (const s of done) {
    const name = INDUSTRY_SPECS[s.type].suffix.replace(/^の/, '');
    if (s.roll < s.chance && !canPlaceIndustry(world, s.type, s.x, s.y, false)) {
      const ind = placeIndustryAt(world, s.type, s.x, s.y, 'player');
      ind.prodRate = Math.round(INDUSTRY_SPECS[s.type].rate * (0.7 + s.roll * 0.6));
      pushEvent(world, { type: 'news', text: `探鉱成功！ ${ind.name}を開発しました（自社・月${ind.prodRate}t）`, tone: 'good', tile: idx(world, ind.x, ind.y) });
    } else {
      pushEvent(world, { type: 'news', text: `探鉱は失敗しました。${name}は見つかりませんでした`, tone: 'bad', tile: idx(world, s.x, s.y) });
    }
  }
}

export function industriesOwnershipMonthly(world: World) {
  for (const ind of world.industries.values()) {
    // 自社：配当と維持費
    if (ind.owner === 'player' && ind.status === 'active') {
      const out = INDUSTRY_SPECS[ind.type].output;
      const div = Math.round(ind.transportedLastMonth * CARGO_SPECS[out].rate * E.dividendRateMul);
      ind.dividendLastMonth = div;
      if (div > 0) earn(world, 'dividends', div);
      spend(world, 'facilities', upkeepPerMonth(ind));
    } else {
      ind.dividendLastMonth = 0;
    }
    // 他社：契約の条件と期限
    if (ind.owner === 'other' && ind.contractUntil > 0) {
      if (world.day >= ind.contractUntil) {
        ind.contractUntil = 0;
        world.version++;
        pushEvent(world, { type: 'news', text: `${ind.name}との輸送契約が終わりました（更新しないと運べません）`, tone: 'bad', tile: idx(world, ind.x, ind.y) });
        continue;
      }
      if (world.day - ind.contractFrom < E.contractGraceDays) continue;
      const pct = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0;
      if (pct >= E.contractMinRate) {
        ind.contractStrikes = 0;
        continue;
      }
      ind.contractStrikes++;
      if (ind.contractStrikes >= E.contractMaxStrikes) {
        ind.contractUntil = 0;
        ind.contractStrikes = 0;
        world.version++;
        pushEvent(world, { type: 'news', text: `${ind.name}との輸送契約が打ち切られました（運び出しが少なすぎました）`, tone: 'bad', tile: idx(world, ind.x, ind.y) });
      } else {
        pushEvent(world, {
          type: 'news',
          text: `${ind.name}：先月の輸送率が${Math.round(pct * 100)}%でした。契約では${Math.round(E.contractMinRate * 100)}%以上が条件です（あと${E.contractMaxStrikes - ind.contractStrikes}か月で打ち切り）`,
          tone: 'bad',
          tile: idx(world, ind.x, ind.y),
        });
      }
    }
  }
  // 他社の一次産業がときどき見つかる
  if (world.industries.size < E.maxIndustries && world.rng.chance(E.discoverPerMonth * paceMul(world))) {
    const type = world.rng.pick(PRIMARY_TYPES);
    const ind = placeIndustrySomewhere(world, type, 'other');
    if (ind) {
      pushEvent(world, {
        type: 'news',
        text: `${ind.name}が見つかりました（他社。権利を買うか、輸送契約で運べます）`,
        tone: 'info',
        tile: idx(world, ind.x, ind.y),
      });
    }
  }
}

export function ownerLabel(world: World, ind: Industry): string {
  if (ind.status === 'building') return '建設中';
  if (INDUSTRY_SPECS[ind.type].partner) return '取引先';
  if (ind.owner === 'player') return '自社';
  if (ind.owner === 'public') return '地元';
  return canLoadFrom(world, ind) ? '契約中' : '他社';
}

export type IndustryStatusCode = 'ok' | 'low' | 'unserved' | 'full' | 'lacking' | 'idle' | 'locked' | 'building';

/** 産業がうまく動いているか（理由と、どうすればよいか） */
export function industryStatus(world: World, ind: Industry): { code: IndustryStatusCode; text: string; tone: 'good' | 'warn' | 'bad' | 'mute' } {
  const spec = INDUSTRY_SPECS[ind.type];
  if (ind.status === 'building') return { code: 'building', text: `建設中（あと${Math.max(0, ind.readyDay - world.day)}日）`, tone: 'mute' };
  if (!canLoadFrom(world, ind)) return { code: 'locked', text: '他社の産業です（権利か輸送契約で運べます）', tone: 'mute' };
  if (ind.outStock > 500 * 0.95) {
    return { code: 'full', text: `${CARGO_SPECS[spec.output].name}の置き場がいっぱいで止まっています。運び出してください`, tone: 'bad' };
  }
  if (spec.inputs.length && !spec.sink) {
    const have = spec.inputs.filter((c) => (ind.inputs[c] ?? 0) >= 1);
    const recent = ind.receivedThisMonth + ind.receivedLastMonth > 0;
    if (!have.length && !recent) {
      return { code: 'idle', text: `材料（${spec.inputs.map((c) => CARGO_SPECS[c].name).join('・')}）が届いていません`, tone: 'warn' };
    }
    if (have.length < spec.inputs.length && spec.inputs.length > 1 && !spec.anyInput) {
      const lack = spec.inputs.filter((c) => !have.includes(c)).map((c) => CARGO_SPECS[c].name);
      return { code: 'lacking', text: `${lack.join('・')}が足りないので止まっています`, tone: 'bad' };
    }
  }
  const produced = ind.producedLastMonth || ind.producedThisMonth;
  const moved = ind.transportedLastMonth || ind.transportedThisMonth;
  if (produced > 0 && moved <= 0) {
    return { code: 'unserved', text: '運び出されていません（近くに駅がない、または列車が積みに来ていません）', tone: 'warn' };
  }
  const pct = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 1;
  if (pct < 0.4) return { code: 'low', text: `運び出しが少なめです（先月の輸送率${Math.round(pct * 100)}%）`, tone: 'warn' };
  return { code: 'ok', text: `順調です（先月の輸送率${Math.round(pct * 100)}%）`, tone: 'good' };
}
