// セーブデータの検査
//
// 「ファイルから読み込む」で、外から渡されたセーブが入ってくる。
// 中身の形・種類・数の範囲をすべて確かめて、合わなければ読み込まない。
// （細工したファイルで画面にスクリプトを仕込まれたり、ゲームが止まったりするのを防ぐ）
//
// 方針：形と範囲だけを見る。駅の ID など「どこを指しているか」は確かめない
// （解体した駅を指令が指したままになるのは、ふつうの遊び方でも起きるため）

import { CARGOS, ENGINE_SPECS, INDUSTRY_SPECS, WAGON_SPECS } from './constants';

export class SaveCheckError extends Error {}

type Obj = Record<string, unknown>;

const MAX_ITEMS = 20_000;
const MAX_NAME = 40;
const MAX_TEXT = 300;

const VEHICLES = new Set([...Object.keys(WAGON_SPECS), ...Object.keys(ENGINE_SPECS)]);
const ENGINES = new Set(Object.keys(ENGINE_SPECS));
const INDUSTRIES = new Set(Object.keys(INDUSTRY_SPECS));
const CARGO_SET = new Set<string>(CARGOS);

function bad(path: string): never {
  throw new SaveCheckError(path);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(path);
  return v as Obj;
}

function arr(v: unknown, path: string, max = MAX_ITEMS): unknown[] {
  if (!Array.isArray(v) || v.length > max) bad(path);
  return v;
}

function num(v: unknown, path: string, min = -1e15, max = 1e15): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(path);
  return v;
}

function int(v: unknown, path: string, min = -1e15, max = 1e15): number {
  num(v, path, min, max);
  if (!Number.isInteger(v)) bad(path);
  return v as number;
}

/** ID（0 以上の整数） */
function id(v: unknown, path: string): number {
  return int(v, path, 0, 1e9);
}

function str(v: unknown, path: string, max = MAX_NAME): string {
  if (typeof v !== 'string' || v.length > max) bad(path);
  return v;
}

function bool(v: unknown, path: string) {
  if (typeof v !== 'boolean') bad(path);
}

function oneOf(v: unknown, set: Set<string> | readonly string[], path: string): string {
  const ok = set instanceof Set ? set.has(v as string) : set.includes(v as string);
  if (typeof v !== 'string' || !ok) bad(path);
  return v as string;
}

function optional(v: unknown, f: () => void) {
  if (v !== undefined && v !== null) f();
}

function numArr(v: unknown, path: string, max = 400) {
  arr(v, path, max).forEach((x, i) => num(x, `${path}[${i}]`));
}

/** 貨物ごとの数（{ lumber: 12 } など） */
function cargoNums(v: unknown, path: string) {
  for (const [k, x] of Object.entries(obj(v, path))) {
    oneOf(k, CARGO_SET, path);
    num(x, `${path}.${k}`);
  }
}

function tile(v: unknown, path: string, n: number) {
  int(v, path, 0, n - 1);
}

function car(v: unknown, path: string, n: number) {
  const c = obj(v, path);
  id(c.id, `${path}.id`);
  oneOf(c.type, VEHICLES, `${path}.type`);
  num(c.built, `${path}.built`);
  arr(c.packets, `${path}.packets`, 2000).forEach((p, i) => {
    const q = obj(p, `${path}.packets[${i}]`);
    num(q.amount, `${path}.packets[${i}].amount`, 0);
    int(q.from, `${path}.packets[${i}].from`, -1);
    int(q.fromTile, `${path}.packets[${i}].fromTile`, -1, n - 1);
    num(q.days, `${path}.packets[${i}].days`, 0);
  });
}

function dest(v: unknown, path: string) {
  const d = obj(v, path);
  oneOf(d.kind, ['industry', 'town'], `${path}.kind`);
  id(d.id, `${path}.id`);
}

/** セーブの world 部分を検査する。おかしければ SaveCheckError（どこが変か） */
export function checkSavedWorld(v: unknown): void {
  const s = obj(v, 'world');
  const w = int(s.w, 'w', 16, 512);
  const h = int(s.h, 'h', 16, 512);
  const n = w * h;
  num(s.seed, 'seed');
  str(s.terrain, 'terrain', n * 2 + 16);
  str(s.track, 'track', n * 2 + 16);

  arr(s.occ, 'occ', n).forEach((e, i) => {
    const p = `occ[${i}]`;
    const [t, o] = arr(e, p, 2);
    tile(t, p, n);
    const oc = obj(o, p);
    const k = oneOf(oc.k, ['station', 'depot', 'industry', 'house'], `${p}.k`);
    if (k === 'house') {
      id(oc.town, `${p}.town`);
      int(oc.level, `${p}.level`, 1, 3);
      int(oc.variant, `${p}.variant`, 0, 1000);
    } else id(oc.id, `${p}.id`);
  });

  arr(s.stations, 'stations').forEach((x, i) => {
    const p = `stations[${i}]`;
    const st = obj(x, p);
    id(st.id, `${p}.id`);
    str(st.name, `${p}.name`);
    arr(st.tiles, `${p}.tiles`, 64).forEach((t, j) => tile(t, `${p}.tiles[${j}]`, n));
    oneOf(st.axis, ['x', 'y'], `${p}.axis`);
    num(st.daysSinceVisit, `${p}.daysSinceVisit`);
    for (const [c, gv] of Object.entries(obj(st.goods, `${p}.goods`))) {
      oneOf(c, CARGO_SET, `${p}.goods`);
      const g = obj(gv, `${p}.goods.${c}`);
      num(g.waiting, `${p}.goods.${c}.waiting`, 0);
      num(g.rating, `${p}.goods.${c}.rating`, 0, 255);
      bool(g.visited, `${p}.goods.${c}.visited`);
      num(g.daysSincePickup, `${p}.goods.${c}.daysSincePickup`);
      num(g.lastSpeed, `${p}.goods.${c}.lastSpeed`);
    }
  });

  arr(s.depots, 'depots').forEach((x, i) => {
    const p = `depots[${i}]`;
    const d = obj(x, p);
    id(d.id, `${p}.id`);
    tile(d.tile, `${p}.tile`, n);
    int(d.dir, `${p}.dir`, 0, 7);
    optional(d.stored, () => arr(d.stored, `${p}.stored`).forEach((c, j) => car(c, `${p}.stored[${j}]`, n)));
  });

  arr(s.industries, 'industries').forEach((x, i) => {
    const p = `industries[${i}]`;
    const ind = obj(x, p);
    id(ind.id, `${p}.id`);
    oneOf(ind.type, INDUSTRIES, `${p}.type`);
    str(ind.name, `${p}.name`);
    int(ind.x, `${p}.x`, 0, w - 1);
    int(ind.y, `${p}.y`, 0, h - 1);
    int(ind.w, `${p}.w`, 1, 8);
    int(ind.h, `${p}.h`, 1, 8);
    cargoNums(ind.inputs, `${p}.inputs`);
    for (const k of [
      'outStock',
      'prodRate',
      'producedThisMonth',
      'transportedThisMonth',
      'receivedThisMonth',
      'producedLastMonth',
      'transportedLastMonth',
      'receivedLastMonth',
      'transportedTotal',
      'receivedTotal',
      'contractUntil',
      'contractFrom',
      'contractStrikes',
      'readyDay',
      'dividendThisMonth',
      'dividendLastMonth',
      'expansions',
    ])
      num(ind[k], `${p}.${k}`);
    oneOf(ind.owner, ['player', 'public', 'other'], `${p}.owner`);
    oneOf(ind.status, ['active', 'building'], `${p}.status`);
    const hist = obj(ind.hist, `${p}.hist`);
    numArr(hist.p, `${p}.hist.p`);
    numArr(hist.t, `${p}.hist.t`);
    numArr(hist.r, `${p}.hist.r`);
  });

  arr(s.towns, 'towns').forEach((x, i) => {
    const p = `towns[${i}]`;
    const t = obj(x, p);
    id(t.id, `${p}.id`);
    str(t.name, `${p}.name`);
    optional(t.custom, () => bool(t.custom, `${p}.custom`));
    int(t.cx, `${p}.cx`, 0, w - 1);
    int(t.cy, `${p}.cy`, 0, h - 1);
    cargoNums(t.stock, `${p}.stock`);
    for (const [c, rv] of Object.entries(obj(t.recv, `${p}.recv`))) {
      oneOf(c, CARGO_SET, `${p}.recv`);
      const r = obj(rv, `${p}.recv.${c}`);
      num(r.m, `${p}.recv.${c}.m`);
      num(r.lm, `${p}.recv.${c}.lm`);
      num(r.total, `${p}.recv.${c}.total`);
    }
    num(t.growthTimer, `${p}.growthTimer`);
    bool(t.fed, `${p}.fed`);
    num(t.population, `${p}.population`, 0);
    num(t.houses, `${p}.houses`, 0);
    num(t.activeStations, `${p}.activeStations`, 0);
    optional(t.popHist, () => numArr(t.popHist, `${p}.popHist`));
    optional(t.stage, () => int(t.stage, `${p}.stage`, 0, 2));
    optional(t.cityWarned, () => bool(t.cityWarned, `${p}.cityWarned`));
  });

  arr(s.trains, 'trains').forEach((x, i) => {
    const p = `trains[${i}]`;
    const t = obj(x, p);
    id(t.id, `${p}.id`);
    str(t.name, `${p}.name`);
    arr(t.cars, `${p}.cars`, 200).forEach((c, j) => car(c, `${p}.cars[${j}]`, n));
    id(t.orderList, `${p}.orderList`);
    int(t.curOrder, `${p}.curOrder`, 0, 1000);
    oneOf(t.state, ['in_depot', 'running', 'loading', 'stopped', 'no_path'], `${p}.state`);
    arr(t.path, `${p}.path`, n).forEach((v2, j) => tile(v2, `${p}.path[${j}]`, n));
    arr(t.trail, `${p}.trail`, n).forEach((v2, j) => tile(v2, `${p}.trail[${j}]`, n));
    num(t.progress, `${p}.progress`, 0, 2);
    oneOf(t.heading, ['order', 'depot'], `${p}.heading`);
    int(t.depotId, `${p}.depotId`, -1);
    int(t.stoppedAt, `${p}.stoppedAt`, -1);
    for (const k of ['loadTimer', 'incomeThisStop', 'profitThisYear', 'profitLastYear', 'profitThisMonth', 'trackVersion'])
      num(t[k], `${p}.${k}`);
    numArr(t.hist, `${p}.hist`);
    optional(t.engineSwap, () => {
      const e = obj(t.engineSwap, `${p}.engineSwap`);
      oneOf(e.type, ENGINES, `${p}.engineSwap.type`);
      bool(e.sellOld, `${p}.engineSwap.sellOld`);
    });
  });

  arr(s.orderLists, 'orderLists').forEach((x, i) => {
    const p = `orderLists[${i}]`;
    const l = obj(x, p);
    id(l.id, `${p}.id`);
    arr(l.orders, `${p}.orders`, 200).forEach((ov, j) => {
      const q = `${p}.orders[${j}]`;
      const o = obj(ov, q);
      id(o.station, `${q}.station`);
      oneOf(o.load, ['if_available', 'full_any', 'full_all', 'none'], `${q}.load`);
      oneOf(o.unload, ['if_accepted', 'none'], `${q}.unload`);
      optional(o.dest, () => dest(o.dest, `${q}.dest`));
      optional(o.split, () =>
        arr(o.split, `${q}.split`, 50).forEach((sv, k) => {
          dest(sv, `${q}.split[${k}]`);
          int((sv as Obj).w, `${q}.split[${k}].w`, 0, 100);
        }),
      );
    });
  });

  id(s.nextId, 'nextId');
  for (const k of ['money', 'loan', 'maxLoan', 'interestRate', 'tick', 'day', 'rng', 'version', 'trackVersion', 'monthIndex'])
    num(s[k], k);
  int(s.day, 'day', 0, 1e7);
  const fin = obj(s.finance, 'finance');
  for (const k of ['thisYear', 'lastYear']) for (const [c, x] of Object.entries(obj(fin[k], `finance.${k}`))) num(x, `finance.${k}.${str(c, 'finance')}`);
  for (const [c, x] of Object.entries(obj(s.monthFin, 'monthFin'))) num(x, `monthFin.${str(c, 'monthFin')}`);
  arr(s.firstArrivals, 'firstArrivals').forEach((x, i) => id(x, `firstArrivals[${i}]`));
  arr(s.unlocked, 'unlocked', 100).forEach((x, i) => oneOf(x, VEHICLES, `unlocked[${i}]`));

  optional(s.requests, () =>
    arr(s.requests, 'requests', 20).forEach((x, i) => {
      const p = `requests[${i}]`;
      const r = obj(x, p);
      id(r.id, `${p}.id`);
      oneOf(r.kind, ['deliver', 'haul', 'carry_pax', 'population', 'connect', 'rating', 'income'], `${p}.kind`);
      str(r.from, `${p}.from`, MAX_TEXT);
      str(r.title, `${p}.title`, MAX_TEXT);
      str(r.desc, `${p}.desc`, MAX_TEXT);
      for (const k of ['target', 'target2', 'goal', 'base', 'progress', 'createdDay', 'deadlineDay']) num(r[k], `${p}.${k}`);
      int(r.tile, `${p}.tile`, -1, n - 1);
      optional(r.cargo, () => oneOf(r.cargo, CARGO_SET, `${p}.cargo`));
      const rw = obj(r.reward, `${p}.reward`);
      if (oneOf(rw.kind, ['money', 'vehicle'], `${p}.reward.kind`) === 'money') num(rw.amount, `${p}.reward.amount`);
      else {
        oneOf(rw.vehicle, VEHICLES, `${p}.reward.vehicle`);
        int(rw.count, `${p}.reward.count`, 1, 20);
        bool(rw.unlock, `${p}.reward.unlock`);
      }
    }),
  );
  const rs = obj(s.requestState, 'requestState');
  for (const k of ['nextCheckDay', 'completed', 'expired', 'incomeTotal']) num(rs[k], `requestState.${k}`);

  optional(s.surveys, () =>
    arr(s.surveys, 'surveys', 100).forEach((x, i) => {
      const p = `surveys[${i}]`;
      const sv = obj(x, p);
      id(sv.id, `${p}.id`);
      oneOf(sv.type, INDUSTRIES, `${p}.type`);
      int(sv.x, `${p}.x`, 0, w - 1);
      int(sv.y, `${p}.y`, 0, h - 1);
      for (const k of ['doneDay', 'chance', 'roll', 'cost']) num(sv[k], `${p}.${k}`);
    }),
  );

  optional(s.market, () => cargoNums(s.market, 'market'));
  optional(s.booms, () =>
    arr(s.booms, 'booms', 50).forEach((x, i) => {
      const p = `booms[${i}]`;
      const b = obj(x, p);
      id(b.id, `${p}.id`);
      oneOf(b.kind, ['rush', 'rebuild', 'shortage', 'tourism'], `${p}.kind`);
      const t = obj(b.target, `${p}.target`);
      oneOf(t.kind, ['town', 'industry'], `${p}.target.kind`);
      id(t.id, `${p}.target.id`);
      oneOf(b.cargo, CARGO_SET, `${p}.cargo`);
      num(b.mul, `${p}.mul`, 0, 10);
      num(b.from, `${p}.from`);
      num(b.until, `${p}.until`);
    }),
  );

  const hist = obj(s.history, 'history');
  for (const k of ['income', 'expense', 'money', 'assets']) numArr(hist[k], `history.${k}`);
}
