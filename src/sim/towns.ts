// 町の段階と、町が受け入れる貨物

import type { Cargo } from './constants';
import type { World } from './world';

/** 町がその貨物を受け入れるか */
export function townAccepts(_world: World, _townId: number, _cargo: Cargo): boolean {
  return true;
}
