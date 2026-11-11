import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/constants';
import { generateWorld } from '../src/sim/mapgen';
import { ensureAirport } from '../src/sim/partners';
import { addShip, buyPartner, capacityOf, extraOutput, loadRoutes, openRoute, removeShip, ROUTES, routesMonthly, type Route } from '../src/sim/routes';
import { deserializeWorld, serializeWorld, toSaveFile } from '../src/sim/save';
import { step } from '../src/sim/simulate';
import { checkSavedWorld } from '../src/sim/validate';

const dayOfYear = (y: number) => Math.round((Date.UTC(y, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);

function portWorld() {
  const w = generateWorld(7, 96, 'coast');
  w.money = 1e11;
  w.requestState.nextCheckDay = 1e9;
  const port = [...w.industries.values()].find((i) => i.type === 'port')!;
  return { w, port };
}

describe('港の買収と航路', () => {
  it('買い取るまで航路は開けない。買い取ると自社の施設になる', () => {
    const { w, port } = portWorld();
    expect(typeof openRoute(w, port.id, 0)).toBe('string');
    const money = w.money;
    expect(buyPartner(w, port.id)).toBeNull();
    expect(port.owner).toBe('player');
    expect(w.money).toBe(money - ROUTES.buyPrice.port);
    expect(buyPartner(w, port.id)).not.toBeNull();
  });

  it('航路を開いて船を足すと、運べる量と石油が増える。同じ行き先は1つだけ', () => {
    const { w, port } = portWorld();
    buyPartner(w, port.id);
    const r = openRoute(w, port.id, 1) as Route;
    expect(typeof r).toBe('object');
    expect(capacityOf(w, port.id)).toBe(ROUTES.ship.sea.capacity);
    expect(typeof openRoute(w, port.id, 1)).toBe('string');
    expect(addShip(w, r.id)).toBeNull();
    expect(capacityOf(w, port.id)).toBe(ROUTES.ship.sea.capacity * 2);
    expect(extraOutput(w, port.id)).toBe(ROUTES.extraOutput.sea * 2);
    const before = port.producedThisMonth;
    step(w, TICKS_PER_DAY * 10);
    expect(port.producedThisMonth - before).toBeGreaterThan(0);
    // 売ると減り、0になると航路が閉じる
    removeShip(w, r.id);
    removeShip(w, r.id);
    expect(w.routes!.length).toBe(0);
  });

  it('届いた貨物は、今月の空きの分だけ運賃になる。月が替わると空きが戻る。維持費がかかる', () => {
    const { w, port } = portWorld();
    buyPartner(w, port.id);
    openRoute(w, port.id, 0);
    const cap = ROUTES.ship.sea.capacity;
    const fare1 = loadRoutes(w, port, cap - 100);
    expect(fare1).toBeGreaterThan(0);
    const fare2 = loadRoutes(w, port, 500);
    expect(fare2).toBeCloseTo(fare1 * (100 / (cap - 100)), -2);
    expect(loadRoutes(w, port, 10)).toBe(0);
    const money = w.money;
    routesMonthly(w);
    expect(w.money).toBeLessThan(money);
    expect(w.routes![0].lastCarried).toBe(cap);
    expect(loadRoutes(w, port, 10)).toBeGreaterThan(0);
  });

  it('空港も買い取って空路を開ける。セーブして読み込んでも残る', () => {
    const w = generateWorld(11);
    w.money = 1e11;
    w.day = dayOfYear(1971);
    const town = [...w.towns.values()][0];
    town.population = 6000;
    town.stage = 2;
    ensureAirport(w);
    const ap = [...w.industries.values()].find((i) => i.type === 'airport')!;
    expect(buyPartner(w, ap.id)).toBeNull();
    const r = openRoute(w, ap.id, 2) as Route;
    expect(r.kind).toBe('air');
    expect(() => checkSavedWorld(toSaveFile(w).world)).not.toThrow();
    const w2 = deserializeWorld(serializeWorld(w));
    expect(w2.routes?.[0].dest).toBe(2);
    expect(w2.industries.get(ap.id)!.owner).toBe('player');
  });
});

describe('空港の駅の旅客', () => {
  it('駅の範囲に空港と町の家があれば、旅客は家のほうが近くても空港へ降ろす', async () => {
    const { acceptanceForRect } = await import('../src/sim/simulate');
    const w = generateWorld(11);
    w.day = dayOfYear(1971);
    const town = [...w.towns.values()][0];
    town.population = 6000;
    town.stage = 2;
    ensureAirport(w);
    const ap = [...w.industries.values()].find((i) => i.type === 'airport')!;
    // 空港にいちばん近い、その町の家
    let best = -1,
      bd = Infinity;
    for (let t = 0; t < w.occ.length; t++) {
      const o = w.occ[t];
      if (o?.k !== 'house' || o.town !== town.id) continue;
      const d = Math.abs((t % w.w) - ap.x) + Math.abs(Math.floor(t / w.w) - ap.y);
      if (d < bd) [bd, best] = [d, t];
    }
    const hx = best % w.w,
      hy = Math.floor(best / w.w);
    // 家を2軒以上ふくむように、家と空港の両方を囲む
    const r = { x0: Math.min(hx, ap.x) - 3, y0: Math.min(hy, ap.y) - 3, x1: Math.max(hx, ap.x + ap.w) + 3, y1: Math.max(hy, ap.y + ap.h) + 3 };
    const acc = acceptanceForRect(w, r, hx, hy);
    const pax = acc.by.passengers!;
    expect(pax.some((a) => a.kind === 'town')).toBe(true);
    expect(pax[0]).toMatchObject({ kind: 'industry', id: ap.id });
  });
});
