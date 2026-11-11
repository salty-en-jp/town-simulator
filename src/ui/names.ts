// 車両・会社の名前を、src/data/zukan.md から入れかえる（v0.8.7）
// ・車両：見出しの日本語（「## steam ツナグ形蒸気機関車」）がゲームの中の名前になる
// ・会社など：「## names-…」の見出しの下の行

import { ENGINE_SPECS, isEngine, PARTNER_NAMES, WAGON_SPECS, type VehicleType } from '../sim/constants';
import { SALES_NAMES } from '../sim/sales';
import { ROUTE_NAMES } from '../sim/routes';
import { parseFlavor, parseNames } from './flavor';
import { setShortName } from './panels';

/** 機関車の短い名前：「○○形」まで（「形」がなければ全部） */
export function shortEngineName(name: string): string {
  return name.match(/^.*?形/)?.[0] ?? name;
}

export function applyNames(md: string) {
  for (const [t, name] of Object.entries(parseNames(md))) {
    const type = t as VehicleType;
    if (isEngine(type)) {
      ENGINE_SPECS[type].name = name;
      setShortName(type, shortEngineName(name));
    } else {
      WAGON_SPECS[type].name = name;
      setShortName(type, name);
    }
  }
  const f = parseFlavor(md);
  const one = (k: string) => f[k]?.[0]?.slice(0, 20);
  const many = (k: string) => (f[k]?.length ? f[k].map((x) => x.slice(0, 20)) : undefined);
  SALES_NAMES.customers = many('names-customers') ?? SALES_NAMES.customers;
  SALES_NAMES.rivalModels = many('names-rival-models') ?? SALES_NAMES.rivalModels;
  SALES_NAMES.tourism = one('names-tourism') ?? SALES_NAMES.tourism;
  SALES_NAMES.rivalMaker = one('names-rival-maker') ?? SALES_NAMES.rivalMaker;
  PARTNER_NAMES.port = one('names-port-company') ?? PARTNER_NAMES.port;
  PARTNER_NAMES.airport = one('names-airport-company') ?? PARTNER_NAMES.airport;
  // 航路の行き先（数は変えず、名前だけ。足りない行は今のまま）
  for (const [k, kind] of [
    ['names-sea-routes', 'sea'],
    ['names-air-routes', 'air'],
  ] as const) {
    many(k)?.forEach((n, i) => {
      if (ROUTE_NAMES[kind][i]) ROUTE_NAMES[kind][i].name = n;
    });
  }
}
