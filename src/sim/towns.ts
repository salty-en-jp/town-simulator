// 町の段階（v0.5.6）と、町が受け入れる貨物
//
//   村   （〜999人）    木材・食料品        … 木材で平屋が建つ
//   町   （1,000人〜）  木材・食料品・建設資材 … アパートが建ち、建設資材でビルにも建て替わる（移り変わりの時期）
//   都市 （5,000人〜）  食料品・建設資材     … 木材はもう受け入れない。建設資材でビルが建つ
//
// 段階は上がるだけ（火事などで人口が少し減っても下がらない）。
// 都市になる少し前（4,500人）にお知らせを出して、運ぶ物を切り替える準備ができるようにする。

import type { Cargo } from './constants';
import { idx, pushEvent, townLabel, type Town, type World } from './world';

export type TownStage = 0 | 1 | 2;

export const STAGES = [
  { name: '村', minPop: 0, goods: ['lumber', 'food'] as Cargo[] },
  { name: '町', minPop: 1000, goods: ['lumber', 'food', 'materials'] as Cargo[] },
  { name: '都市', minPop: 5000, goods: ['food', 'materials'] as Cargo[] },
] as const;

export const TOWN_GROWTH = {
  /** 届いた材料で建てる・建て替える間隔（日）。段階が上がるほどゆっくり */
  buildEvery: [3, 6, 8] as const,
  /** 町の段階で、ビル（ランク3）にできる家の割合の上限 */
  townMaxTallShare: 0.2,
  /** 都市になる少し前に知らせる人口 */
  cityWarnPop: 4500,
};

/** 人口から決まる段階 */
export function stageForPop(pop: number): TownStage {
  return pop >= STAGES[2].minPop ? 2 : pop >= STAGES[1].minPop ? 1 : 0;
}

export function townStage(town: Town): TownStage {
  return (town.stage ?? stageForPop(town.population)) as TownStage;
}

export function stageName(town: Town): string {
  return STAGES[townStage(town)].name;
}

/** 町がその貨物を受け入れるか（旅客はいつも） */
export function townAccepts(world: World, townId: number, cargo: Cargo): boolean {
  if (cargo === 'passengers') return true;
  const town = world.towns.get(townId);
  if (!town) return false;
  return STAGES[townStage(town)].goods.includes(cargo);
}

/** 毎日：段階を上げる・都市の前に知らせる。段階が変わったら true（受け入れが変わる） */
export function updateTownStage(world: World, town: Town): boolean {
  const want = stageForPop(town.population);
  if (town.stage === undefined) {
    // 前の版のセーブ：いまの人口で決める（お知らせは出さない）
    town.stage = want;
    town.cityWarned = want >= 2 || town.population >= TOWN_GROWTH.cityWarnPop;
    return true;
  }
  const tile = idx(world, town.cx, town.cy);
  if (town.stage < 2 && !town.cityWarned && town.population >= TOWN_GROWTH.cityWarnPop) {
    town.cityWarned = true;
    pushEvent(world, {
      type: 'news',
      text: `${townLabel(town)}はもうすぐ都市になります。都市になると木材は受け入れず、建設資材だけになります`,
      tone: 'info',
      tile,
    });
  }
  if (want <= town.stage) return false;
  town.stage = want;
  pushEvent(world, {
    type: 'news',
    text:
      want === 1
        ? `${townLabel(town)}が「町」になりました！ 建設資材も受け入れ、ビルが建ちはじめます`
        : `${townLabel(town)}が「都市」になりました！ これからは木材ではなく建設資材でビルが建ちます`,
    tone: 'good',
    tile,
  });
  return true;
}
