// 依頼ボード（まったりプレイ用のミッション）
//
// ・いつも最大3件の依頼が出ている。達成するとお金や車両がもらえる
// ・期限が切れても罰はない（依頼が消えて、そのうち新しい依頼が来るだけ）
// ・報酬の車両は車庫の留置線に届く。まだ買えない車両は「解禁」もされる
// ・会社が大きくなるほど、依頼も大きくなる

import { townAccepts } from './towns';
import { formatYen } from './commands';
import {
  CARGO_SPECS,
  ENGINE_TYPES,
  INDUSTRY_SPECS,
  isEngine,
  TOWN_GOODS,
  vehicleCost,
  vehicleName,
  WAGON_SPECS,
  WAGON_TYPES,
  type Cargo,
  type VehicleType,
} from './constants';
import { findPath } from './track';
import {
  canLoadFrom,
  dateOf,
  earn,
  idx,
  isPrimary,
  newCar,
  newId,
  recvOf,
  pushEvent,
  rectContains,
  stationCatchment,
  tx,
  ty,
  vehicleYear,
  type Station,
  type World,
  townLabel,
} from './world';

export type RequestKind = 'deliver' | 'haul' | 'carry_pax' | 'population' | 'connect' | 'rating' | 'income';

export type Reward =
  | { kind: 'money'; amount: number }
  | { kind: 'vehicle'; vehicle: VehicleType; count: number; unlock: boolean };

export interface Request {
  id: number;
  kind: RequestKind;
  /** 依頼主（町・産業の名前） */
  from: string;
  title: string;
  desc: string;
  target: number;
  target2: number;
  /** 運ぶ貨物（haul・deliver のとき） */
  cargo?: Cargo;
  goal: number;
  /** 依頼を受けたときの累計（ここからの増えた分を数える） */
  base: number;
  progress: number;
  createdDay: number;
  deadlineDay: number;
  reward: Reward;
  /** 「場所を見る」で移動する先（なければ -1） */
  tile: number;
}

export interface RequestState {
  nextCheckDay: number;
  completed: number;
  expired: number;
  /** はじめからの運賃収入の累計 */
  incomeTotal: number;
}

export const MAX_REQUESTS = 3;
const RATING_GOAL = Math.round(255 * 0.7);

const round = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);

// ───────────────────────── 進み具合 ─────────────────────────

/** 町の近くの駅（町の中心か、その町の家が集客範囲に入っている駅） */
export function townStations(world: World, townId: number): Station[] {
  const town = world.towns.get(townId);
  if (!town) return [];
  const out: Station[] = [];
  for (const st of world.stations.values()) {
    const r = stationCatchment(world, st);
    let hit = rectContains(r, town.cx, town.cy);
    for (let y = r.y0; y <= r.y1 && !hit; y++) {
      for (let x = r.x0; x <= r.x1 && !hit; x++) {
        const o = world.occ[idx(world, x, y)];
        if (o?.k === 'house' && o.town === townId) hit = true;
      }
    }
    if (hit) out.push(st);
  }
  return out;
}

export function townsConnected(world: World, a: number, b: number): boolean {
  const sa = townStations(world, a),
    sb = townStations(world, b);
  if (!sa.length || !sb.length) return false;
  const goals = new Set(sb.flatMap((s) => s.tiles));
  return sa.some((s) => findPath(world, s.tiles[0], goals) !== null);
}

function bestRating(world: World): number {
  let best = 0;
  for (const st of world.stations.values()) {
    for (const g of Object.values(st.goods)) if (g.visited) best = Math.max(best, g.rating);
  }
  return best;
}

function counter(world: World, r: Request): number {
  switch (r.kind) {
    case 'deliver': {
      const t = world.towns.get(r.target);
      return t && r.cargo ? recvOf(t, r.cargo).total : 0;
    }
    case 'carry_pax': {
      const t = world.towns.get(r.target);
      return t ? recvOf(t, 'passengers').total : 0;
    }
    case 'haul':
      return world.industries.get(r.target)?.transportedTotal ?? 0;
    case 'income':
      return world.requestState.incomeTotal;
    default:
      return 0;
  }
}

function measure(world: World, r: Request): number {
  switch (r.kind) {
    case 'population':
      return world.towns.get(r.target)?.population ?? 0;
    case 'connect':
      return townsConnected(world, r.target, r.target2) ? 1 : 0;
    case 'rating':
      return bestRating(world);
    default:
      return counter(world, r) - r.base;
  }
}

// ───────────────────────── 依頼をつくる ─────────────────────────

function pick<T>(world: World, arr: T[]): T | undefined {
  return arr.length ? world.rng.pick(arr) : undefined;
}

/**
 * 報酬を決める。ふだんはお金。
 * ときどき「まだ登場していない新型車両を一足早く使える」報酬になる（依頼の貨物に合う車両を優先）
 */
function makeReward(world: World, _kind: RequestKind, scale: number, money: number, cargo?: Cargo): Reward {
  const year = dateOf(world.day).y;
  const offered = new Set(
    world.requests.flatMap((r) => (r.reward.kind === 'vehicle' && r.reward.unlock ? [r.reward.vehicle] : [])),
  );
  const upcoming = ([...ENGINE_TYPES, ...WAGON_TYPES] as VehicleType[])
    .filter((t) => {
      const y = vehicleYear(t);
      return y !== undefined && y > year && y - year <= 6 && !world.unlocked.has(t) && !offered.has(t);
    })
    .sort((p, q) => vehicleYear(p)! - vehicleYear(q)!);
  const match = cargo ? upcoming.find((t) => !isEngine(t) && WAGON_SPECS[t].cargo === cargo) : undefined;
  const v = match ?? upcoming[0];
  if (v && world.rng.chance(match ? 0.25 : 0.1)) return { kind: 'vehicle', vehicle: v, count: isEngine(v) ? 1 : 2, unlock: true };
  return { kind: 'money', amount: round(money * scale, 500_000) };
}

const DELIVER_TEXT: Partial<Record<Cargo, { goal: number; why: string; money: number }>> = {
  lumber: { goal: 60, why: '新しい家を建てたいそうです。', money: 6_000_000 },
  food: { goal: 50, why: '町の人が食べる食料品が足りないそうです。', money: 7_000_000 },
  materials: { goal: 40, why: '高いビルを建てたいそうです。', money: 9_000_000 },
  specialty: { goal: 30, why: 'よその町の名産品を味わいたいそうです。', money: 8_000_000 },
};

function makeRequest(world: World): Request | null {
  const st = world.requestState;
  const scale = 1 + st.completed * 0.35;
  const towns = [...world.towns.values()];
  // 運び出せる一次産業だけ（他社で権利も契約もない産業は対象にしない）
  const primaries = [...world.industries.values()].filter((i) => isPrimary(i.type) && canLoadFrom(world, i));
  const active = new Set(world.requests.map((r) => `${r.kind}:${r.target}:${r.target2}:${r.cargo ?? ''}`));
  const hasVisited = [...world.stations.values()].some((s) => Object.values(s.goods).some((g) => g.visited));
  const kinds: RequestKind[] = ['haul', 'deliver', 'carry_pax', 'population'];
  if (towns.length >= 2) kinds.push('connect');
  if (hasVisited) kinds.push('rating');
  if (st.incomeTotal > 0) kinds.push('income');
  // 最初の依頼はいちばんわかりやすいもの（最初の森から原木を運び出す）
  const first = st.completed === 0 && st.expired === 0 && world.requests.length === 0;
  const kind: RequestKind = first ? 'haul' : world.rng.pick(kinds);

  const base = {
    id: newId(world),
    kind,
    target: -1,
    target2: -1,
    base: 0,
    progress: 0,
    createdDay: world.day,
    tile: -1,
  };
  let r: Request | null = null;
  switch (kind) {
    case 'haul': {
      const f = first ? primaries.find((i) => i.type === 'forest') : pick(world, primaries);
      if (!f) return null;
      const cargo = INDUSTRY_SPECS[f.type].output;
      const cname = CARGO_SPECS[cargo].name;
      const goal = round(120 * scale, 10);
      r = {
        ...base,
        from: f.name,
        title: `${f.name}の${cname}を運び出して`,
        desc: `${cname}を${goal}t運び出してください。たまって困っているそうです。`,
        target: f.id,
        cargo,
        goal,
        deadlineDay: world.day + 365,
        reward: makeReward(world, kind, scale, 4_000_000, cargo),
        tile: idx(world, f.x + 1, f.y + 1),
      };
      break;
    }
    case 'deliver': {
      const t = pick(world, towns);
      if (!t) return null;
      // その町がいま受け入れている物だけ（都市に木材は頼まない）
      const goods = TOWN_GOODS.filter((c) => townAccepts(world, t.id, c));
      if (!goods.length) return null;
      const cargo = world.rng.pick(goods);
      const info = DELIVER_TEXT[cargo]!;
      const cname = CARGO_SPECS[cargo].name;
      const goal = round(info.goal * scale, 10);
      r = {
        ...base,
        from: `${townLabel(t)}`,
        title: `${townLabel(t)}に${cname}を届けて`,
        desc: `${cname}を${goal}t、${townLabel(t)}に届けてください。${info.why}`,
        target: t.id,
        cargo,
        goal,
        deadlineDay: world.day + 365,
        reward: makeReward(world, kind, scale, info.money, cargo),
        tile: idx(world, t.cx, t.cy),
      };
      break;
    }
    case 'carry_pax': {
      const t = pick(world, towns);
      if (!t) return null;
      const goal = round(80 * scale, 10);
      r = {
        ...base,
        from: `${townLabel(t)}`,
        title: `${townLabel(t)}へお客さんを`,
        desc: `${CARGO_SPECS.passengers.name}を${goal}人、${townLabel(t)}の駅へ運んでください。`,
        target: t.id,
        goal,
        deadlineDay: world.day + 365,
        reward: makeReward(world, kind, scale, 4_000_000),
        tile: idx(world, t.cx, t.cy),
      };
      break;
    }
    case 'population': {
      const t = pick(world, towns);
      if (!t) return null;
      const goal = round(Math.max(t.population * 1.3, t.population + 60), 50);
      r = {
        ...base,
        from: `${townLabel(t)}`,
        title: `${townLabel(t)}を人口${goal.toLocaleString('ja-JP')}人に`,
        desc: `${townLabel(t)}の人口を${goal.toLocaleString('ja-JP')}人にしてください。駅を使い、木材を届けると早く育ちます。`,
        target: t.id,
        goal,
        deadlineDay: world.day + 730,
        reward: makeReward(world, kind, scale, 8_000_000),
        tile: idx(world, t.cx, t.cy),
      };
      break;
    }
    case 'connect': {
      const pairs: [number, number][] = [];
      for (const a of towns) for (const b of towns) if (a.id < b.id && !townsConnected(world, a.id, b.id)) pairs.push([a.id, b.id]);
      const p = pick(world, pairs);
      if (!p) return null;
      const A = world.towns.get(p[0])!,
        B = world.towns.get(p[1])!;
      r = {
        ...base,
        from: `${townLabel(A)}`,
        title: `${townLabel(A)}と${townLabel(B)}を線路でつないで`,
        desc: `両方の町の近くに駅をつくり、線路でつないでください。`,
        target: A.id,
        target2: B.id,
        goal: 1,
        deadlineDay: world.day + 540,
        reward: makeReward(world, kind, scale, 10_000_000),
        tile: idx(world, B.cx, B.cy),
      };
      break;
    }
    case 'rating': {
      r = {
        ...base,
        from: 'ツナグ鉄道 利用者の会',
        title: '評価の高い駅をつくって',
        desc: 'どれかの駅で、貨物の評価を70%以上にしてください。列車をこまめに来させると上がります。',
        goal: RATING_GOAL,
        deadlineDay: world.day + 240,
        reward: makeReward(world, kind, scale, 3_000_000),
      };
      break;
    }
    case 'income': {
      const goal = round(30_000_000 * scale, 5_000_000);
      r = {
        ...base,
        from: '銀行',
        title: `運賃収入${formatYen(goal)}`,
        desc: `この依頼を受けてから、運賃収入を合計${formatYen(goal)}稼いでください。`,
        goal,
        deadlineDay: world.day + 365,
        reward: makeReward(world, kind, scale, 6_000_000),
      };
      break;
    }
  }
  if (!r) return null;
  if (active.has(`${r.kind}:${r.target}:${r.target2}:${r.cargo ?? ''}`)) return null;
  r.base = counter(world, r);
  r.progress = Math.min(r.goal, Math.max(0, measure(world, r)));
  return r;
}

// ───────────────────────── 報酬 ─────────────────────────

export function rewardText(r: Reward): string {
  if (r.kind === 'money') return formatYen(r.amount);
  return `${vehicleName(r.vehicle)}${r.count > 1 ? `×${r.count}` : ''}${r.unlock ? '（一足早く解禁）' : ''}`;
}

function giveReward(world: World, req: Request) {
  const r = req.reward;
  if (r.kind === 'money') {
    earn(world, 'rewards', r.amount);
    pushEvent(world, { type: 'news', text: `依頼達成！「${req.title}」報酬 ${formatYen(r.amount)}`, tone: 'good', tile: req.tile });
    return;
  }
  if (r.unlock) world.unlocked.add(r.vehicle);
  const depot = [...world.depots.values()][0];
  if (!depot) {
    // 車庫がなければお金で
    const amount = vehicleCost(r.vehicle) * r.count;
    earn(world, 'rewards', amount);
    pushEvent(world, {
      type: 'news',
      text: `依頼達成！「${req.title}」車庫がないので ${formatYen(amount)} を受け取りました${r.unlock ? `（${vehicleName(r.vehicle)}が買えるようになりました）` : ''}`,
      tone: 'good',
      tile: req.tile,
    });
    return;
  }
  for (let k = 0; k < r.count; k++) depot.stored.push(newCar(world, r.vehicle));
  pushEvent(world, {
    type: 'news',
    text: `依頼達成！「${req.title}」${rewardText(r)}が車庫の留置線に届きました${r.unlock ? `。登場（${vehicleYear(r.vehicle)}年）より一足早く、買うこともできます` : ''}`,
    tone: 'good',
    tile: depot.tile,
  });
}

// ───────────────────────── 毎日の更新 ─────────────────────────

export function updateRequests(world: World) {
  const st = world.requestState;
  const keep = [];
  for (const r of world.requests) {
    // 線路のつながりの確認は少し重いので10日に1回
    if (r.kind !== 'connect' || world.day % 10 === 0) r.progress = Math.min(r.goal, Math.max(0, measure(world, r)));
    if (r.progress >= r.goal) {
      st.completed++;
      giveReward(world, r);
      continue;
    }
    if (world.day >= r.deadlineDay) {
      st.expired++;
      pushEvent(world, { type: 'news', text: `依頼「${r.title}」は期限が切れました`, tone: 'info' });
      continue;
    }
    keep.push(r);
  }
  world.requests = keep;
  if (world.day >= st.nextCheckDay) {
    st.nextCheckDay = world.day + world.rng.int(25, 45);
    if (world.requests.length < MAX_REQUESTS) {
      for (let tries = 0; tries < 4; tries++) {
        const r = makeRequest(world);
        if (!r) continue;
        world.requests.push(r);
        pushEvent(world, { type: 'news', text: `新しい依頼：「${r.title}」（${r.from}）`, tone: 'info', tile: r.tile >= 0 ? r.tile : undefined });
        break;
      }
    }
  }
}

export function daysLeft(world: World, r: Request): number {
  return Math.max(0, r.deadlineDay - world.day);
}

export function requestTile(world: World, r: Request): { x: number; y: number } | null {
  return r.tile >= 0 ? { x: tx(world, r.tile), y: ty(world, r.tile) } : null;
}
