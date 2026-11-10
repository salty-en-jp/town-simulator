// セーブデータの検査
//
// 「ファイルから読み込む」で、外から渡されたセーブが入ってくる。
// 中身の形・種類・数の範囲をすべて確かめて、合わなければ読み込まない。
// （細工したファイルで画面にスクリプトを仕込まれたり、ゲームが止まったりするのを防ぐ）
//
// 方針：形と範囲だけを見る。駅の ID など「どこを指しているか」は確かめない
// （解体した駅を指令が指したままになるのは、ふつうの遊び方でも起きるため）

import { METRICS, RULE_TEXT } from './challenge';
import { PARTS } from './tech';
import { CARGOS, DEV_POWERS, DEV_USES, ENGINE_SPECS, INDUSTRY_SPECS, isDevEngine, WAGON_SPECS } from './constants';

export class SaveCheckError extends Error {}

type Obj = Record<string, unknown>;

const MAX_ITEMS = 20_000;
const MAX_NAME = 40;
const MAX_TEXT = 300;

const BASE_ENGINES = Object.keys(ENGINE_SPECS).filter((k) => !isDevEngine(k));
// 自社開発の機関車（dev12 など）は、そのセーブの開発記録にあるものだけを認める
let VEHICLES = new Set([...Object.keys(WAGON_SPECS), ...BASE_ENGINES]);
let ENGINES = new Set(BASE_ENGINES);
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
  designs(s);
  optional(s.companyName, () => str(s.companyName, 'companyName'));

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
    optional(ind.specialty, () => oneOf(ind.specialty, ['pottery', 'fruit', 'tea', 'driedfish'], `${p}.specialty`));
    optional(ind.town, () => id(ind.town, `${p}.town`));
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
    optional(t.fame, () => num(t.fame, `${p}.fame`, 0));
    optional(t.fameNotified, () => num(t.fameNotified, `${p}.fameNotified`, 0));
    optional(t.noWorkshop, () => bool(t.noWorkshop, `${p}.noWorkshop`));
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

  optional(s.rank, () => int(s.rank, 'rank', 0, 50));
  optional(s.achievements, () => {
    const a = obj(s.achievements, 'achievements');
    if (Object.keys(a).length > 200) bad('achievements');
    for (const [k, v] of Object.entries(a)) {
      str(k, 'achievements', 40);
      num(v, `achievements.${k}`);
    }
  });
  optional(s.stats, () => {
    const st = obj(s.stats, 'stats');
    optional(st.cargo, () => cargoNums(st.cargo, 'stats.cargo'));
    optional(st.boomTons, () => num(st.boomTons, 'stats.boomTons', 0));
    optional(st.intercityPax, () => num(st.intercityPax, 'stats.intercityPax', 0));
    optional(st.paxIncome, () => num(st.paxIncome, 'stats.paxIncome'));
  });

  optional(s.pace, () => oneOf(s.pace, ['slow', 'normal', 'fast'], 'pace'));
  optional(s.landform, () => oneOf(s.landform, ['mixed', 'mountains', 'plains', 'coast'], 'landform'));
  optional(s.electric, () => str(s.electric, 'electric', n * 2 + 16));
  optional(s.challenge, () => {
    const c = obj(s.challenge, 'challenge');
    oneOf(c.kind, ['stage', 'daily', 'random'], 'challenge.kind');
    str(c.id, 'challenge.id', 40);
    str(c.title, 'challenge.title', 80);
    str(c.lead, 'challenge.lead', 200);
    num(c.seed, 'challenge.seed');
    oneOf(c.metric, Object.keys(METRICS), 'challenge.metric');
    const g = arr(c.goals, 'challenge.goals', 3);
    if (g.length !== 3) bad('challenge.goals');
    g.forEach((x, i) => num(x, `challenge.goals[${i}]`));
    num(c.years, 'challenge.years', 0, 100);
    arr(c.rules, 'challenge.rules', 5).forEach((x, i) => oneOf(x, Object.keys(RULE_TEXT), `challenge.rules[${i}]`));
    num(c.startDay, 'challenge.startDay');
    num(c.endDay, 'challenge.endDay');
    optional(c.done, () => bool(c.done, 'challenge.done'));
  });

  const hist = obj(s.history, 'history');
  for (const k of ['income', 'expense', 'money', 'assets']) numArr(hist[k], `history.${k}`);
}

/** 自社開発の記録（v0.8.2）。できあがった機関車を、使ってよい車両に加える */
function designs(s: Obj) {
  const done: string[] = [];
  optional(s.designs, () => {
    const ids = new Set<number>();
    arr(s.designs, 'designs', 100).forEach((v, i) => {
      const p = `designs[${i}]`;
      const d = obj(v, p);
      const did = int(d.id, `${p}.id`, 0);
      if (ids.has(did)) bad(`${p}.id`);
      ids.add(did);
      str(d.name, `${p}.name`);
      oneOf(d.power, DEV_POWERS, `${p}.power`);
      oneOf(d.use, DEV_USES, `${p}.use`);
      int(d.budget, `${p}.budget`, 0, 2);
      int(d.color, `${p}.color`, 0, 0xffffff);
      num(d.start, `${p}.start`);
      int(d.days, `${p}.days`, 1, 10_000);
      int(d.progress, `${p}.progress`, 0, 10_000);
      const pts = obj(d.pts, `${p}.pts`);
      for (const k of ['speed', 'might', 'economy', 'comfort']) num(pts[k], `${p}.pts.${k}`, 0, 1e6);
      arr(d.tests, `${p}.tests`, 2).forEach((t, j) => {
        const r = obj(t, `${p}.tests[${j}]`);
        oneOf(r.choice, ['safe', 'bold', 'daring'], `${p}.tests[${j}].choice`);
        bool(r.ok, `${p}.tests[${j}].ok`);
      });
      optional(d.waiting, () => bool(d.waiting, `${p}.waiting`));
      optional(d.defect, () => bool(d.defect, `${p}.defect`));
      optional(d.rating, () => int(d.rating, `${p}.rating`, 1, 5));
      optional(d.award, () => int(d.award, `${p}.award`, 1900, 3000));
      optional(d.sale, () => {
        const sl = obj(d.sale, `${p}.sale`);
        bool(sl.on, `${p}.sale.on`);
        int(sl.markup, `${p}.sale.markup`, 0, 3);
        int(sl.sold, `${p}.sale.sold`, 0);
        num(sl.profit, `${p}.sale.profit`);
        int(sl.lastMonth, `${p}.sale.lastMonth`, 0);
        num(sl.acc, `${p}.sale.acc`, 0, 1000);
        optional(sl.ended, () => bool(sl.ended, `${p}.sale.ended`));
      });
      optional(d.done, () => {
        num(d.done, `${p}.done`);
        done.push(`dev${did}`);
      });
    });
  });
  optional(s.devFame, () => num(s.devFame, 'devFame', 0, 100));
  optional(s.tech, () => num(s.tech, 'tech', 0, 1e6));
  optional(s.makerOwned, () => bool(s.makerOwned, 'makerOwned'));
  optional(s.parts, () => arr(s.parts, 'parts', 100).forEach((x, i) => oneOf(x, PARTS.map((p) => p.id), `parts[${i}]`)));
  optional(s.devTrend, () => {
    const t = obj(s.devTrend, 'devTrend');
    oneOf(t.use, DEV_USES, 'devTrend.use');
    int(t.year, 'devTrend.year', 1900, 3000);
  });
  optional(s.devOrders, () =>
    arr(s.devOrders, 'devOrders', 10).forEach((v, i) => {
      const p = `devOrders[${i}]`;
      const o = obj(v, p);
      int(o.id, `${p}.id`, 0);
      str(o.from, `${p}.from`);
      oneOf(o.use, DEV_USES, `${p}.use`);
      optional(o.power, () => oneOf(o.power, DEV_POWERS, `${p}.power`));
      int(o.minRating, `${p}.minRating`, 1, 5);
      num(o.deadline, `${p}.deadline`);
      int(o.units, `${p}.units`, 1, 100);
    }),
  );
  optional(s.awards, () =>
    arr(s.awards, 'awards', 100).forEach((v, i) => {
      const p = `awards[${i}]`;
      const a = obj(v, p);
      int(a.year, `${p}.year`, 1900, 3000);
      str(a.name, `${p}.name`);
      str(a.maker, `${p}.maker`);
      bool(a.mine, `${p}.mine`);
    }),
  );
  VEHICLES = new Set([...Object.keys(WAGON_SPECS), ...BASE_ENGINES, ...done]);
  ENGINES = new Set([...BASE_ENGINES, ...done]);
}
