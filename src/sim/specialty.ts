// 名産品（v0.7.1）
//
// ・どの町にも、そばに「名産の工房」が1つある。名産の種類はまわりの土地で決まる
//   （海辺＝干物、山地のそば＝焼き物、木の多い所＝お茶、平野＝果物）
// ・名産品は1つの貨物。遠くの、大きな町（町・都市）ほど高く買う。生まれた町では売れない
// ・たくさん運び出すと、その町の評判が上がり、観光客（旅客）が増える

import { SPECIALTIES, type SpecialtyKind } from './constants';
import { canPlaceIndustry, placeIndustryAt, rockRatio, treeRatio, waterAround } from './industries';
import { townNear } from './towns';
import { idx, pushEvent, townLabel, type Industry, type Town, type World } from './world';

export const SPECIALTY = {
  /** 名産品の買取の上乗せ：大きな町ほど高い（この人口で最大） */
  fullPop: 8000,
  maxBonus: 1,
  /** 町が1日に使う名産品（人口1,000人あたり） */
  usePerThousand: 1.5,
  /** 評判：毎月この割合に下がる。観光客は最大この割合まで増える */
  fameKeep: 0.85,
  famePerPax: 1500,
  maxPaxBonus: 0.6,
};

/** まわりの土地から、名産の種類を決める */
export function specialtyKindFor(world: World, cx: number, cy: number): SpecialtyKind {
  if (waterAround(world, cx - 4, cy - 4, 8, 8, 4) >= 20) return 'driedfish';
  if (rockRatio(world, cx, cy, 8) > 0.06) return 'pottery';
  if (treeRatio(world, cx, cy, 6) > 0.18) return 'tea';
  return 'fruit';
}

export function workshopOf(world: World, townId: number): Industry | undefined {
  return [...world.industries.values()].find((i) => i.type === 'workshop' && i.town === townId);
}

/** 町のそばに名産の工房を置く（置けなければ null） */
export function placeWorkshop(world: World, town: Town, news = false): Industry | null {
  const kind = specialtyKindFor(world, town.cx, town.cy);
  for (let r = 5; r <= 11; r++) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + r;
      const x = Math.round(town.cx + Math.cos(a) * r) - 1,
        y = Math.round(town.cy + Math.sin(a) * r) - 1;
      if (canPlaceIndustry(world, 'workshop', x, y, false)) continue;
      // ほかの産業とは少し離す
      if ([...world.industries.values()].some((i) => Math.abs(i.x - x) + Math.abs(i.y - y) < 6)) continue;
      const ind = placeIndustryAt(world, 'workshop', x, y, 'public');
      ind.specialty = kind;
      ind.town = town.id;
      ind.name = `${town.name}の${SPECIALTIES[kind].place}`;
      if (news) {
        pushEvent(world, {
          type: 'news',
          text: `${townLabel(town)}の名産「${SPECIALTIES[kind].name}」の${SPECIALTIES[kind].place}が見つかりました。遠くの大きな町ほど高く売れます`,
          tone: 'good',
          tile: idx(world, x, y),
        });
      }
      return ind;
    }
  }
  return null;
}

/** 名産品の買取の上乗せ（大きな町ほど高い） */
export function specialtyBonus(town: Town | undefined): number {
  if (!town) return 1;
  return 1 + SPECIALTY.maxBonus * Math.min(1, town.population / SPECIALTY.fullPop);
}

/** 荷物の名産品が、届け先の町で生まれたものか（それなら売れない） */
export function isHomeSpecialty(world: World, fromTile: number, town: Town): boolean {
  return townNear(world, fromTile)?.id === town.id;
}

/** 名産品の名前（「桜川の焼き物」）。積んだ駅のそばの町から */
export function specialtyLabel(world: World, townId: number): string {
  const ws = workshopOf(world, townId);
  const t = world.towns.get(townId);
  return ws?.specialty && t ? `${t.name}の${SPECIALTIES[ws.specialty].name}` : '名産品';
}

/** 評判による観光客の増え方 */
export function famePaxMul(town: Town | undefined): number {
  if (!town?.fame) return 1;
  return 1 + Math.min(SPECIALTY.maxPaxBonus, town.fame / SPECIALTY.famePerPax);
}

/** 工房から運び出したとき：その町の評判が上がる */
export function addFame(world: World, ind: Industry, amount: number) {
  if (ind.town === undefined) return;
  const t = world.towns.get(ind.town);
  if (t) t.fame = (t.fame ?? 0) + amount;
}

/** 毎日：町が名産品を使う */
export function specialtyDaily(world: World) {
  for (const t of world.towns.values()) {
    const s = t.stock.specialty ?? 0;
    if (s > 0) t.stock.specialty = Math.max(0, s - (t.population / 1000) * SPECIALTY.usePerThousand);
  }
}

/** 毎月：評判が少し下がる・有名になったらお知らせ。工房のない町には1つ見つける（前の版のセーブ） */
export function specialtyMonthly(world: World) {
  for (const t of world.towns.values()) {
    const before = t.fame ?? 0;
    const after = before * SPECIALTY.fameKeep;
    t.fame = Math.round(after * 10) / 10;
    for (const th of [300, 900]) {
      if (before >= th && (t.fameNotified ?? 0) < th) {
        t.fameNotified = th;
        const ws = workshopOf(world, t.id);
        pushEvent(world, {
          type: 'news',
          text: `${specialtyLabel(world, t.id)}が${th >= 900 ? '大評判' : '評判'}に！ ${townLabel(t)}に観光客が増えています`,
          tone: 'good',
          tile: ws ? idx(world, ws.x, ws.y) : idx(world, t.cx, t.cy),
        });
      }
    }
  }
  const lacking = [...world.towns.values()].find((t) => !workshopOf(world, t.id) && !t.noWorkshop);
  if (lacking && !placeWorkshop(world, lacking, true)) lacking.noWorkshop = true;
}
