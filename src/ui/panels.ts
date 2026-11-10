// 各ウィンドウの中身（HTML）とボタンの動作

import { VERSION } from '../version';
import { openZukan } from './zukan';
import { openDevel } from './develUi';
import { engineList } from '../sim/devel';
import { manualHtml, releaseNotesHtml } from './manual';
import {
  addOrder,
  attachVehicle,
  borrow,
  buyVehicle,
  carValue,
  deleteOrder,
  detachVehicle,
  disbandTrain,
  formatYen,
  makeTrain,
  repay,
  sellTrain,
  sellVehicle,
  sendToDepot,
  cancelEngineSwap,
  moveOrder,
  rename,
  renameCompany,
  scheduleEngineSwap,
  setOrderDest,
  setOrderLoad,
  setOrderSplit,
  setOrderUnload,
  skipOrder,
  startStop,
  stationTrains,
  trainValue,
} from '../sim/commands';
import {
  CARGO_SPECS,
  SPECIALTIES,
  CARGOS,
  ENGINE_SPECS,
  FINANCE,
  INDUSTRY,
  FACTORY_TYPES,
  INDUSTRY_ECON,
  INDUSTRY_SPECS,
  isEngine,
  PRIMARY_TYPES,
  TOWN,
  TOWN_GOODS,
  vehicleCost,
  vehicleName,
  vehicleValue,
  WAGON_SPECS,
  WAGON_TYPES,
  type Cargo,
  type EngineType,
  type IndustryType,
  type VehicleType,
} from '../sim/constants';
import { demandFactor } from '../sim/economy';
import {
  buyRights,
  contractFee,
  expandCost,
  expandIndustry,
  industryStatus,
  ownerLabel,
  rightsPrice,
  signContract,
  upkeepPerMonth,
} from '../sim/industries';
import { achievedLabel, ACHIEVEMENTS, companyValue, connectedPopulation, rankIndex, RANKS } from '../sim/company';
import { activeBooms, BOOM_LABEL, boomPlace, boomTile, marketIndex, type Boom } from '../sim/market';
import { daysLeft, rewardText } from '../sim/requests';
import { intercityMul, STAGES, stageName, townAccepts, townStage } from '../sim/towns';
import { famePaxMul, workshopOf } from '../sim/specialty';
import { acceptorDemand, acceptorName, acceptors, acceptorStock, stationAccepts } from '../sim/simulate';
import {
  canBuy,
  carCapacity,
  canLoadFrom,
  consistError,
  PACES,
  type Pace,
  dateOf,
  vehicleYear,
  carCargo,
  carLoad,
  FINANCE_CATEGORIES,
  isPrimary,
  stationSign,
  trainEngine,
  tx,
  ty,
  type FinanceCategory,
  type Industry,
  type LoadMode,
  type Order,
  type Station,
  type Town,
  type Train,
  type UnloadMode,
  townLabel,
  companyName,
} from '../sim/world';
import type { Game } from '../game';
import { lineChart, monthsAgo, shortYen, sparkline } from './chart';
import { ICONS } from './icons';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const n0 = (v: number) => Math.floor(v).toLocaleString('ja-JP');
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function gauge(value: number, max: number, cls = '') {
  const r = Math.max(0, Math.min(1, value / max));
  return `<span class="gauge ${cls}"><span style="width:${(r * 100).toFixed(1)}%"></span></span>`;
}

export const LOAD_LABELS: Record<LoadMode, string> = {
  if_available: 'ある分だけ積む',
  full_any: 'いずれかが満載まで待つ',
  full_all: 'すべて満載まで待つ',
  none: '積まない',
};
export const UNLOAD_LABELS: Record<UnloadMode, string> = {
  if_accepted: '受け入れ先があれば降ろす',
  none: '降ろさない',
};

// ───────────────────────── 列車 ─────────────────────────

export function trainStatus(g: Game, t: Train): { text: string; tone: string } {
  const w = g.world;
  const orders = w.orderLists.get(t.orderList)!.orders;
  const target = orders[t.curOrder % Math.max(1, orders.length)];
  const stName = target ? (w.stations.get(target.station)?.name ?? '?') : '';
  switch (t.state) {
    case 'in_depot':
      return { text: '車庫で停止中 — クリックで発車', tone: 'stop' };
    case 'stopped':
      return { text: '停止中 — クリックで発車', tone: 'stop' };
    case 'loading': {
      const st = w.stations.get(t.stoppedAt);
      const waitFull = target && (target.load === 'full_any' || target.load === 'full_all');
      return { text: `${st?.name ?? ''}で積み降ろし中${waitFull ? '（満載待ち）' : ''}`, tone: 'ok' };
    }
    case 'no_path':
      return {
        text: t.heading === 'depot' ? '車庫への線路がつながっていません' : `${stName}への線路がつながっていません`,
        tone: 'bad',
      };
    default:
      if (t.heading === 'depot' && t.engineSwap) return { text: `機関車の交換のため車庫へ向かっています`, tone: 'ok' };
      return { text: t.heading === 'depot' ? '車庫へ向かっています' : `${stName}へ向かっています`, tone: 'ok' };
  }
}

export function openTrain(g: Game, id: number) {
  g.selectTrain(id);
  g.wm.open({
    id: `train-${id}`,
    rename: {
      get: () => g.world.trains.get(id)?.name ?? '',
      set: (name) => {
        const ok = g.result(rename(g.world, 'train', id, name));
        g.wm.refreshAll();
        return ok;
      },
    },
    get title() {
      return g.world.trains.get(id)?.name ?? '列車';
    },
    width: 330,
    render: () => {
      const t = g.world.trains.get(id);
      if (!t) return '<p class="muted">この列車はもうありません</p>';
      const s = trainStatus(g, t);
      const eng = ENGINE_SPECS[trainEngine(t)];
      const cars = t.cars
        .map((c) => {
          if (isEngine(c.type)) return `<li><span class="car-dot ${c.type}"${dotStyle(c.type)}></span>${esc(vehicleName(c.type))}<span class="grow"></span><span class="muted small">${ageText(g, c.built)}</span></li>`;
          const cargo = carCargo(c)!;
          const cap = carCapacity(c, cargo);
          return `<li><span class="car-dot ${c.type}"${dotStyle(c.type)}></span>${esc(vehicleName(c.type))}<span class="grow"></span>${gauge(carLoad(c), cap)}<span class="num">${n0(carLoad(c))}/${cap}${CARGO_SPECS[cargo].unit}</span></li>`;
        })
        .join('');
      const inDepot = t.state === 'in_depot';
      return `
        <button class="status-bar ${s.tone}" data-action="startstop">${esc(s.text)}</button>
        <div class="btnrow">
          <button data-action="orders">${ICONS.orders}<span>指令</span></button>
          ${
            inDepot
              ? `<button data-action="consist">${ICONS.depot}<span>編成を変える</span></button>`
              : `<button data-action="depot">${ICONS.depot}<span>${t.heading === 'depot' ? '取りやめ' : '車庫へ送る'}</span></button>`
          }
          <button data-action="center">${ICONS.center}<span>表示</span></button>
        </div>
        ${
          t.engineSwap
            ? `<div class="hint swap-wait">機関車の交換待ち：${esc(vehicleName(t.engineSwap.type))}（車庫に入ったら交換して、また走り出します）<button class="small-btn" data-action="cancel-swap">取りやめ</button></div>`
            : `<div class="btnrow"><button data-action="swap">${ICONS.train}<span>機関車を交換</span></button></div>`
        }
        <ul class="cars">${cars}</ul>
        <dl class="stats">
          <dt>速さ</dt><dd>${eng.speed}マス/日</dd>
          <dt>今年の利益</dt><dd class="${t.profitThisYear >= 0 ? 'pos' : 'neg'}">${formatYen(t.profitThisYear)}</dd>
          <dt>去年の利益</dt><dd>${formatYen(t.profitLastYear)}</dd>
          <dt>維持費（走っているとき）</dt><dd>${formatYen(eng.runningCostPerYear)}/年</dd>
        </dl>
        ${inDepot ? '' : '<p class="muted small">編成を変えるには、いったん車庫へ送ってください。</p>'}
        ${trainCharts(g, t)}`;
    },
    onAction: (a) => {
      const t = g.world.trains.get(id);
      if (!t) return;
      if (a === 'startstop') g.result(startStop(g.world, id));
      else if (a === 'orders') openOrders(g, id);
      else if (a === 'depot') g.result(sendToDepot(g.world, id));
      else if (a === 'center') g.centerOnTrain(id);
      else if (a === 'swap') openEngineSwap(g, id);
      else if (a === 'cancel-swap') g.result(cancelEngineSwap(g.world, id));
      else if (a === 'consist') {
        g.depotSel.set(t.depotId, id);
        openDepot(g, t.depotId);
      }
      g.wm.refreshAll();
    },
    onClose: () => {
      if (g.selectedTrain === id) g.selectTrain(-1);
    },
  });
}

/** 列車の利益（路線全体も）と、車両の値段の下がり方 */
function trainCharts(g: Game, t: Train): string {
  const w = g.world;
  const mates = [...w.trains.values()].filter((x) => x.orderList === t.orderList);
  const series = [{ name: 'この列車', color: '#2c4a3e', data: t.hist }];
  if (mates.length > 1) {
    const len = Math.max(...mates.map((m) => m.hist.length));
    const sum = new Array(len).fill(0);
    for (const m of mates) m.hist.forEach((v, i) => (sum[len - m.hist.length + i] += v));
    series.push({ name: `路線全体（${mates.length}本）`, color: '#d8a32a', data: sum });
  }
  const profit = `<h4>毎月の利益 <small class="muted">運賃 − 維持費</small></h4>${lineChart(series, {
    format: shortYen,
    xLeft: monthsAgo(Math.max(1, ...series.map((x) => x.data.length))),
    xRight: '先月',
  })}`;
  // 減価償却：いちばん古い車両を買った日から15年後まで
  const from = Math.min(...t.cars.map((c) => c.built));
  const span = 15 * 365;
  const pts: number[] = [];
  for (let k = 0; k <= 15; k++) {
    const d = from + k * 365;
    pts.push(t.cars.reduce((sum, c) => sum + (d >= c.built ? vehicleValue(c.type, d - c.built) : 0), 0));
  }
  const now = trainValue(w, t);
  const paid = t.cars.reduce((sum, c) => sum + vehicleCost(c.type), 0);
  const value = `<h4>車両の値段 <small class="muted">年数とともに下がります（減価償却）</small></h4>
    ${lineChart([{ name: '売るときの値段', color: '#4f74a3', data: pts }], {
      format: shortYen,
      xLeft: '買ったとき',
      xRight: '15年後',
      marker: { at: Math.min(1, (w.day - from) / span), label: 'いま' },
    })}
    <p class="small">いま売ると <b>${formatYen(now)}</b>（買ったときの値段 ${formatYen(paid)}）</p>`;
  return profit + value;
}

/** 会社の収支・所持金・車両の資産価値 */
function financeCharts(g: Game): string {
  const h = g.world.history;
  const n = Math.max(1, h.income.length);
  const opts = { format: shortYen, xLeft: monthsAgo(n), xRight: '先月' };
  return `<h4>毎月の収入と支出</h4>
    ${lineChart(
      [
        { name: '収入', color: '#2f8a4a', data: h.income },
        { name: '支出', color: '#c0443a', data: h.expense },
      ],
      opts,
    )}
    <h4>所持金と車両の資産価値 <small class="muted">資産価値は減価償却後の値段の合計</small></h4>
    ${lineChart(
      [
        { name: '所持金', color: '#2c4a3e', data: h.money },
        { name: '車両の資産価値', color: '#4f74a3', data: h.assets, dashed: true },
      ],
      opts,
    )}`;
}

// ───────────────────────── 機関車の交換 ─────────────────────────

/** 機関車だけを替える（貨車と指令はそのまま）。この列車だけ／同じ指令の列車／同じ機関車の列車 */
export function openEngineSwap(g: Game, trainId: number) {
  const ui = { scope: 'one' as 'one' | 'route' | 'type', type: '' as EngineType | '', sell: false };
  const targets = (): Train[] => {
    const w = g.world;
    const t = w.trains.get(trainId);
    if (!t) return [];
    if (ui.scope === 'one') return [t];
    if (ui.scope === 'route') return [...w.trains.values()].filter((x) => x.orderList === t.orderList);
    return [...w.trains.values()].filter((x) => x.cars[0]?.type === t.cars[0]?.type);
  };
  g.wm.open({
    id: `swap-${trainId}`,
    title: '機関車の交換',
    width: 360,
    render: () => {
      const w = g.world;
      const t = w.trains.get(trainId);
      if (!t) return '<p class="muted">この列車はもうありません</p>';
      const cur = t.cars[0].type;
      const sameRoute = [...w.trains.values()].filter((x) => x.orderList === t.orderList).length;
      const sameEngine = [...w.trains.values()].filter((x) => x.cars[0]?.type === cur).length;
      const spares = (e: EngineType) => [...w.depots.values()].reduce((n, d) => n + d.stored.filter((c) => c.type === e).length, 0);
      const engines = engineList(w).filter((e) => e !== cur)
        .map((e) => {
          const avail = canBuy(w, e) || spares(e) > 0;
          // この列車の貨車をそのまま引けるか（両数・客車だけ／貨車だけ）
          const bad = consistError(e, t.cars.slice(1).map((c) => c.type));
          const ok = avail && !bad;
          const why = !avail ? `${vehicleYear(e)}年に登場します` : (bad ?? '');
          if (!avail && (vehicleYear(e) ?? 0) - dateOf(w.day).y > 5) return '';
          return `<button class="buy ${ui.type === e ? 'on' : ''}" data-action="type" data-e="${e}" ${ok ? '' : `disabled title="${esc(why)}"`}>
            <span class="buy-name"><span class="car-dot ${e}"${dotStyle(e)}></span>${shortName(e)}${ok ? '' : ` <small class="muted">${esc(!avail ? `${vehicleYear(e)}年〜` : 'この編成は引けない')}</small>`}</span>
            <span class="num">${formatYen(vehicleCost(e))}</span>
            <span class="muted small">${vehicleDesc(e)}${spares(e) ? `・留置線に${spares(e)}両` : ''}</span></button>`;
        })
        .join('');
      const list = targets().filter((x) => x.cars[0]?.type !== ui.type);
      const inDepot = list.filter((x) => x.state === 'in_depot').length;
      const radio = (k: string, v: string, label: string) =>
        `<label class="check"><input type="radio" name="scope-${trainId}" data-key="${k}" value="${v}" ${(ui as Record<string, unknown>)[k] === v || (k === 'sell' && String(ui.sell) === v) ? 'checked' : ''}> ${label}</label>`;
      return `
        <p class="small">いまの機関車：<b>${esc(vehicleName(cur))}</b>。貨車と指令はそのままで、先頭の機関車だけを替えます。</p>
        <h4>どの列車を</h4>
        ${radio('scope', 'one', `この列車だけ（${esc(t.name)}）`)}
        ${radio('scope', 'route', `同じ指令の列車すべて（${sameRoute}本）`)}
        ${radio('scope', 'type', `${esc(shortName(cur))}の列車すべて（${sameEngine}本）`)}
        <h4>新しい機関車</h4>
        <div class="buy-grid">${engines || '<p class="muted small">ほかの機関車がありません</p>'}</div>
        <h4>古い機関車</h4>
        <label class="check"><input type="radio" name="sell-${trainId}" data-key="sell" value="false" ${!ui.sell ? 'checked' : ''}> 車庫の留置線に置く</label>
        <label class="check"><input type="radio" name="sell-${trainId}" data-key="sell" value="true" ${ui.sell ? 'checked' : ''}> 売る</label>
        ${
          ui.type
            ? `<p class="small">${list.length}本を交換します。${inDepot ? `車庫にいる${inDepot}本はすぐ、` : ''}${list.length - inDepot ? `走っている${list.length - inDepot}本は、いちばん近い車庫に入ったときに交換して、そのまま走り出します。` : ''}</p>`
            : '<p class="muted small">新しい機関車を選んでください。</p>'
        }
        <div class="btnrow"><button class="primary" data-action="go" ${ui.type && list.length ? '' : 'disabled'}><span>交換する</span></button></div>`;
    },
    onAction: (a, el) => {
      if (a === 'type') ui.type = el.dataset.e as EngineType;
      if (a === 'go' && ui.type) {
        const r = scheduleEngineSwap(g.world, targets().map((x) => x.id), ui.type, ui.sell);
        if (g.result(r)) {
          g.toast(`機関車の交換：すぐ${r.now ?? 0}本・車庫に入ったら${r.later ?? 0}本`, 'good');
          g.wm.close(`swap-${trainId}`);
        }
      }
      g.wm.refreshAll();
    },
    onChange: (el) => {
      if (el.dataset.key === 'scope') ui.scope = el.value as typeof ui.scope;
      if (el.dataset.key === 'sell') ui.sell = el.value === 'true';
      g.wm.refresh(`swap-${trainId}`, true);
    },
  });
}

function ageText(g: Game, built: number): string {
  const y = Math.floor((g.world.day - built) / 365);
  return y <= 0 ? '新車' : `${y}年`;
}

// ───────────────────────── 指令 ─────────────────────────

export function openOrders(g: Game, id: number) {
  g.wm.open({
    id: `orders-${id}`,
    get title() {
      return `${g.world.trains.get(id)?.name ?? '列車'}（指令）`;
    },
    width: 360,
    render: () => {
      const w = g.world;
      const t = w.trains.get(id);
      if (!t) return '<p class="muted">この列車はもうありません</p>';
      const ol = w.orderLists.get(t.orderList)!;
      const sel = Math.min(g.orderSel.get(id) ?? -1, ol.orders.length - 1);
      const shared = [...w.trains.values()].filter((x) => x.orderList === ol.id).length;
      const rows = ol.orders
        .map((o, i) => {
          const st = w.stations.get(o.station);
          const extra = [
            o.load !== 'if_available' ? LOAD_LABELS[o.load] : '',
            o.unload === 'none' ? '降ろさない' : '',
            o.dest ? `届け先：${acceptorName(w, o.dest)}` : '',
            o.split ? `振り分け：${o.split.filter((x) => x.w > 0).map((x) => acceptorName(w, x)).join('・')}` : '',
          ]
            .filter(Boolean)
            .join('・');
          return `<li class="order ${i === sel ? 'sel' : ''} ${i === t.curOrder ? 'cur' : ''}" data-action="sel" data-i="${i}" ${g.touchUI ? '' : 'draggable="true"'}>
            <span class="oi">${i === t.curOrder ? '▶' : ''}${i + 1}:</span>
            <span>${esc(st?.name ?? '?')}へ${extra ? `<small>（${esc(extra)}）</small>` : ''}</span></li>`;
        })
        .join('');
      const o = sel >= 0 ? ol.orders[sel] : null;
      const picking = g.tool === 'order' && g.orderTrain === id;
      return `
        <ol class="orders">${rows || '<li class="muted">指令がありません。「行き先」を押して地図の駅を選んでください</li>'}
          <li class="order end ${sel === -1 ? 'sel' : ''}" data-action="sel" data-i="-1">— 指令の終わり —</li></ol>
        ${shared > 1 ? `<p class="muted small">この指令は ${shared} 本の列車で共有しています</p>` : ''}
        <div class="field-row">
          <label>積み込み<select data-key="load" ${o ? '' : 'disabled'}>
            ${(Object.keys(LOAD_LABELS) as LoadMode[]).map((k) => `<option value="${k}" ${o?.load === k ? 'selected' : ''}>${LOAD_LABELS[k]}</option>`).join('')}
          </select></label>
          <label>荷降ろし<select data-key="unload" ${o ? '' : 'disabled'}>
            ${(Object.keys(UNLOAD_LABELS) as UnloadMode[]).map((k) => `<option value="${k}" ${o?.unload === k ? 'selected' : ''}>${UNLOAD_LABELS[k]}</option>`).join('')}
          </select></label>
        </div>
        ${o ? destField(g, t, o) : ''}
        <div class="btnrow wrap order-actions">
          <button class="${picking ? 'on' : ''}" data-action="goto" title="地図の駅をクリック（Ctrl+クリックで満載待ち）">${ICONS.station}<span>行き先</span></button>
          <button data-action="up" ${o && sel > 0 ? '' : 'disabled'} title="上へ" aria-label="上へ">${ICONS.up}</button>
          <button data-action="down" ${o && sel < ol.orders.length - 1 ? '' : 'disabled'} title="下へ" aria-label="下へ">${ICONS.down}</button>
          <button data-action="delete" ${o ? '' : 'disabled'}>${ICONS.remove}<span>削除</span></button>
          <button data-action="skip" ${ol.orders.length ? '' : 'disabled'}>${ICONS.skip}<span>スキップ</span></button>
        </div>
        ${picking ? `<p class="hint">${g.touchUI ? '地図の駅か駅名をタップ。終わったら下のバーの「完了」' : '地図の駅か駅名をクリック（Ctrl+クリックで「満載まで待つ」）。終わったら下のバーの「完了」か Esc'}</p>` : ''}`;
    },
    onAction: (a, el) => {
      const t = g.world.trains.get(id);
      if (!t) return;
      if (a === 'sel') g.orderSel.set(id, Number(el.dataset.i));
      else if (a === 'up' || a === 'down') {
        const sel = g.orderSel.get(id) ?? -1;
        const to = sel + (a === 'up' ? -1 : 1);
        if (g.result(moveOrder(g.world, id, sel, to))) g.orderSel.set(id, to);
      } else if (a === 'goto') g.startOrderPick(id);
      else if (a === 'delete') {
        const sel = g.orderSel.get(id) ?? -1;
        g.result(deleteOrder(g.world, id, sel));
        g.orderSel.set(id, Math.min(sel, g.world.orderLists.get(t.orderList)!.orders.length - 1));
      } else if (a === 'skip') g.result(skipOrder(g.world, id));
      g.wm.refreshAll();
    },
    onChange: (el) => {
      const sel = g.orderSel.get(id) ?? -1;
      if (el.dataset.key === 'load') g.result(setOrderLoad(g.world, id, sel, el.value as LoadMode));
      if (el.dataset.key === 'unload') g.result(setOrderUnload(g.world, id, sel, el.value as UnloadMode));
      const t = g.world.trains.get(id);
      const o = t ? g.world.orderLists.get(t.orderList)!.orders[sel] : undefined;
      if (el.dataset.key === 'dest' && t && o) {
        if (el.value === 'split') {
          // はじめは均等に振り分ける
          g.result(setOrderSplit(g.world, id, sel, [...destOptions(g, t, o).keys()].map((k) => ({ ...keyToDest(k), w: 5 }))));
        } else {
          g.result(setOrderDest(g.world, id, sel, el.value === 'auto' ? null : keyToDest(el.value)));
        }
      }
      if (el.dataset.key?.startsWith('splitw-') && t && o) {
        const keys = [...destOptions(g, t, o).keys()];
        const split = keys.map((k) => ({ ...keyToDest(k), w: o.split?.find((x) => `${x.kind}:${x.id}` === k)?.w ?? 0 }));
        const target = split.find((x) => `${x.kind}:${x.id}` === el.dataset.k);
        if (target) target.w = Number(el.value);
        if (split.every((x) => x.w === 0)) target!.w = 1;
        g.result(setOrderSplit(g.world, id, sel, split));
      }
      g.wm.refreshAll();
    },
    onInput: (el, body) => {
      // 動かしている最中も割合（%）を表示し直す。値は指を離したときに決める
      if (!el.dataset.key?.startsWith('splitw-')) return;
      const inputs = [...body.querySelectorAll<HTMLInputElement>('.split input[type="range"]')];
      const sum = inputs.reduce((n, i) => n + Number(i.value), 0) || 1;
      for (const i of inputs) {
        const out = i.parentElement?.querySelector('.num');
        if (out) out.textContent = `${Math.round((Number(i.value) / sum) * 100)}%`;
      }
    },
    onReorder: (from, to) => {
      if (g.result(moveOrder(g.world, id, from, to))) g.orderSel.set(id, to);
      g.wm.refreshAll();
    },
    onClose: () => {
      if (g.tool === 'order' && g.orderTrain === id) g.setTool('none');
    },
  });
}

/** 届け先の候補（列車が運ぶ貨物を、その駅で受け入れる先） */
function destOptions(g: Game, t: Train, o: Order): Map<string, string> {
  const w = g.world;
  const st = w.stations.get(o.station);
  const options = new Map<string, string>();
  if (!st) return options;
  const cargos = [...new Set(t.cars.map((c) => carCargo(c)).filter((c): c is Cargo => !!c))];
  for (const c of cargos) {
    for (const a of acceptors(w, st, c)) {
      const key = `${a.kind}:${a.id}`;
      const part = `${CARGO_SPECS[c].name} ×${acceptorDemand(w, a, c).toFixed(2)}`;
      options.set(key, options.has(key) ? options.get(key)!.replace('）', `・${part}）`) : `${acceptorName(w, a)}（${part}）`);
    }
  }
  return options;
}

const keyToDest = (k: string) => {
  const [kind, id] = k.split(':');
  return { kind: kind as 'industry' | 'town', id: Number(id) };
};

/**
 * 届け先の選択欄。列車が運ぶ貨物を、その駅で受け入れる先が2つ以上あるときだけ選べる。
 * 「振り分ける」を選ぶと、受け入れ先ごとの割合で分けて降ろす（1両でも）
 */
function destField(g: Game, t: Train, o: Order): string {
  const options = destOptions(g, t, o);
  if (options.size === 0) return '';
  if (options.size === 1) return `<p class="small muted">届け先：${esc([...options.values()][0])}</p>`;
  const cur = o.split ? 'split' : o.dest ? `${o.dest.kind}:${o.dest.id}` : 'auto';
  let splitRows = '';
  if (o.split) {
    const sum = o.split.reduce((n, x) => n + x.w, 0) || 1;
    splitRows = [...options]
      .map(([k, v]) => {
        const wgt = o.split!.find((x) => `${x.kind}:${x.id}` === k)?.w ?? 0;
        return `<label class="split-row"><span class="ellipsis">${esc(v.replace(/（.*$/, ''))}</span>
          <input type="range" min="0" max="10" step="1" value="${wgt}" data-key="splitw-${k}" data-k="${k}">
          <b class="num">${Math.round((wgt / sum) * 100)}%</b></label>`;
      })
      .join('');
  }
  return `<div class="field-row"><label>届け先（この駅で受け入れる先が${options.size}つあります）<select data-key="dest">
      <option value="auto" ${cur === 'auto' ? 'selected' : ''}>自動（いちばん近い所）</option>
      ${[...options].map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      <option value="split" ${cur === 'split' ? 'selected' : ''}>振り分ける（割合を決める）</option>
    </select></label></div>
    ${splitRows ? `<div class="split">${splitRows}<p class="muted small">1両の荷でも、この割合で分けて降ろします。いっぱいで入らない分は、ほかの届け先に回します。</p></div>` : ''}`;
}

/** 指令の追加（地図で駅を選んだとき） */
export function addOrderFromMap(g: Game, trainId: number, stationId: number, full: boolean) {
  const t = g.world.trains.get(trainId);
  if (!t) return;
  const sel = g.orderSel.get(trainId) ?? -1;
  const r = addOrder(g.world, trainId, stationId, full ? 'full_any' : 'if_available', sel >= 0 ? sel : undefined);
  g.result(r);
  if (r.ok) {
    if (sel >= 0) g.orderSel.set(trainId, sel + 1);
    g.toast(`指令を追加：${g.world.stations.get(stationId)!.name}${full ? '（満載まで待つ）' : ''}`, 'info');
  }
  g.wm.refreshAll();
}

// ───────────────────────── 車庫（留置線と編成の組み替え） ─────────────────────────

const SHORT_NAMES: Record<VehicleType, string> = {
  steam: 'ツナグ形',
  express: 'ハヤテ形',
  coach: '客車',
  logcar: '原木車',
  lumbercar: '木材車',
  graincar: '穀物車',
  foodcar: '冷蔵車',
  orecar: '鉱石車',
  coalcar: '石炭車',
  steelcar: '鋼材車',
  materialcar: '資材車',
  biglogcar: '大型原木車',
  biglumbercar: '大型木材車',
  heavy: 'ゴウリキ形',
  superexpress: 'ツバサ形',
  biggraincar: '大型穀物車',
  freshcar: '新型冷蔵車',
  bigcoach: '大型客車',
  bigorecar: '大型鉱石車',
  bigcoalcar: '大型石炭車',
  bigsteelcar: '大型鋼材車',
  bigmaterialcar: '大型資材車',
  livestockcar: '家畜車',
  fishcar: '魚の冷蔵車',
  specialtycar: '名産品車',
};

/** 短い名前（自社開発の機関車は付けた名前） */
function shortName(t: VehicleType): string {
  return SHORT_NAMES[t] ?? vehicleName(t);
}

/** 自社開発の機関車は、選んだ色の丸 */
function dotStyle(t: VehicleType): string {
  const c = isEngine(t) ? ENGINE_SPECS[t].color : undefined;
  return c === undefined ? '' : ` style="background:#${c.toString(16).padStart(6, '0')}"`;
}

function vehicleDesc(t: VehicleType): string {
  if (isEngine(t)) {
    const e = ENGINE_SPECS[t];
    return `${e.color !== undefined ? '自社開発・' : ''}${e.speed}マス/日・${e.maxCars}両まで・${e.allow === 'pax' ? '客車だけ' : e.allow === 'freight' ? '貨車だけ' : 'なんでも'}${e.comfort && e.comfort > 1 ? `・運賃×${e.comfort.toFixed(2)}` : ''}`;
  }
  if (WAGON_SPECS[t].fresh) {
    const w = WAGON_SPECS[t];
    return `${CARGO_SPECS[w.cargo].name}${w.capacity}${CARGO_SPECS[w.cargo].unit}・傷みにくい`;
  }
  const w = WAGON_SPECS[t];
  return `${CARGO_SPECS[w.cargo].name}${w.capacity}${CARGO_SPECS[w.cargo].unit}`;
}

/** 「車両 3/8両・客車だけ」のような、機関車の決まりの表示 */
function engineLimitText(t: Train, wagons: number): string {
  const head = t.cars[0]?.type;
  if (!head || !isEngine(head)) return `車両${wagons}両`;
  const e = ENGINE_SPECS[head];
  return `車両${wagons}/${e.maxCars}両${e.allow === 'pax' ? '・客車だけ' : e.allow === 'freight' ? '・貨車だけ' : ''}`;
}

export function openDepot(g: Game, id: number) {
  g.wm.open({
    id: `depot-${id}`,
    title: '車庫',
    width: 360,
    render: () => {
      const w = g.world;
      const depot = w.depots.get(id);
      if (!depot) return '<p class="muted">この車庫はもうありません</p>';
      const inside = [...w.trains.values()].filter((t) => t.depotId === id && t.state === 'in_depot');
      let sel = g.depotSel.get(id) ?? -1;
      if (!inside.some((t) => t.id === sel)) sel = inside.length === 1 ? inside[0].id : -1;
      g.depotSel.set(id, sel);
      const selTrain = inside.find((t) => t.id === sel);
      const cloning = g.tool === 'clone' && g.cloneDepot === id;

      const trains = inside
        .map((t) => {
          const chips = t.cars
            .map((c, i) =>
              i === 0
                ? `<span class="chip ${c.type}"${dotStyle(c.type)}>${shortName(c.type)}</span>`
                : `<button class="chip ${c.type}"${dotStyle(c.type)} data-action="detach" data-train="${t.id}" data-car="${c.id}" title="外して留置線へ">${shortName(c.type)}<b>↓</b></button>`,
            )
            .join('');
          const wagons = t.cars.length - 1;
          return `<li class="dtrain ${t.id === sel ? 'sel' : ''}" data-action="seltrain" data-id="${t.id}">
            <div class="dtrain-head"><b>${esc(t.name)}</b><span class="muted small">${engineLimitText(t, wagons)}</span><span class="grow"></span>
              <button class="small-btn" data-action="start" data-id="${t.id}">${ICONS.play}発車</button></div>
            <div class="consist">${chips}</div></li>`;
        })
        .join('');

      // 留置線は種類ごとにまとめる（機関車 → 貨車の順、同じ種類は古い順）
      const order = [...engineList(w), ...WAGON_TYPES] as VehicleType[];
      const sorted = [...depot.stored].sort((p, q) => order.indexOf(p.type) - order.indexOf(q.type) || p.built - q.built);
      const counts = new Map<VehicleType, number>();
      for (const c of sorted) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
      let lastType: VehicleType | null = null;
      const stored = sorted
        .map((c) => {
          const head = c.type !== lastType ? `<li class="group"><span class="car-dot ${c.type}"${dotStyle(c.type)}></span>${shortName(c.type)} ×${counts.get(c.type)}</li>` : '';
          lastType = c.type;
          const engine = isEngine(c.type);
          const action = engine
            ? `<button class="small-btn" data-action="maketrain" data-car="${c.id}">列車にする</button>`
            : `<button class="small-btn" data-action="attach" data-car="${c.id}" ${selTrain ? '' : 'disabled title="先に上で列車を選んでください"'}>↑つなぐ</button>`;
          return `${head}<li class="sub"><span>${shortName(c.type)}<small class="muted"> ${ageText(g, c.built)}</small></span><span class="grow"></span>${action}<button class="small-btn" data-action="sellcar" data-car="${c.id}" title="売却">売る ${formatYen(carValue(w, c))}</button></li>`;
        })
        .join('');

      const buy = [...engineList(w), ...WAGON_TYPES]
        .map((t) => {
          const ok = canBuy(w, t);
          const yr = vehicleYear(t);
          if (!ok && yr !== undefined && yr - dateOf(w.day).y > 5) return ''; // 先すぎる車両はまだ出さない
          return `<button class="buy ${ok ? '' : 'locked'}" data-action="buy" data-k="${t}" ${ok ? '' : 'disabled'} title="${ok ? '' : `${yr}年に登場します（依頼の報酬で一足早く使えることもあります）`}">
            <span class="buy-name"><span class="car-dot ${t}"${dotStyle(t)}></span>${shortName(t)}</span>
            <span class="muted small">${ok ? '' : `<b>${yr}年に登場</b>・`}${vehicleDesc(t)}</span>
            <span class="num">${formatYen(vehicleCost(t))}</span></button>`;
        })
        .join('');

      return `
        <h4>車庫の中の列車</h4>
        <ul class="dtrains">${trains || '<li class="muted small">なし（機関車を買うと列車になります）</li>'}</ul>
        ${
          selTrain
            ? `<div class="btnrow">
                <button data-action="orders">${ICONS.orders}<span>指令</span></button>
                <button data-action="disband" title="すべての車両を留置線に置きます（指令は消えます）">${ICONS.remove}<span>ばらす</span></button>
                <button class="danger" data-action="selltrain"><span>列車ごと売る ${formatYen(trainValue(w, selTrain))}</span></button>
              </div>`
            : ''
        }
        <h4>留置線 <small class="muted">${depot.stored.length}両・置いている間は維持費なし</small></h4>
        <ul class="list stored">${stored || '<li class="muted small">なし（外した車両や買った貨車がここに置かれます）</li>'}</ul>
        <h4>車両を買う <button class="link small" data-action="zukan">車両図鑑</button></h4>
        <div class="buy-grid">${buy}</div>
        <p class="muted small">${selTrain ? `貨車は<b>${esc(selTrain.name)}</b>に直接つながります。` : '貨車は留置線に置かれます。'}機関車を買うと新しい列車になります。</p>
        <div class="btnrow">
          <button class="${cloning ? 'on' : ''}" data-action="clone" title="押してから地図上の列車をクリック（Ctrl+クリックで指令を共有）">${ICONS.clone}<span>クローン</span></button>
        </div>
        ${
          cloning
            ? `<p class="hint">複製したい列車を地図で${g.touchUI ? 'タップ' : 'クリック（Ctrl+クリックで指令を共有）'}</p>
               <label class="check"><input type="checkbox" data-key="share" ${g.cloneShare ? 'checked' : ''}> 指令を共有する</label>`
            : ''
        }`;
    },
    onAction: (a, el, ev) => {
      if (a === 'zukan') return openZukan(g);
      const w = g.world;
      const sel = g.depotSel.get(id) ?? -1;
      const car = Number(el.dataset.car);
      switch (a) {
        case 'seltrain':
          if ((ev.target as HTMLElement).closest('button')) return;
          g.depotSel.set(id, Number(el.dataset.id) === sel ? -1 : Number(el.dataset.id));
          break;
        case 'start':
          g.result(startStop(w, Number(el.dataset.id)));
          break;
        case 'detach':
          g.result(detachVehicle(w, Number(el.dataset.train), car));
          break;
        case 'attach':
          g.result(attachVehicle(w, id, car, sel));
          break;
        case 'maketrain': {
          const r = makeTrain(w, id, car);
          if (g.result(r) && r.id) g.depotSel.set(id, r.id);
          break;
        }
        case 'sellcar':
          g.result(sellVehicle(w, id, car));
          break;
        case 'buy': {
          const r = buyVehicle(w, id, el.dataset.k as VehicleType, { attachTo: sel });
          if (g.result(r) && isEngine(el.dataset.k as VehicleType) && r.id) {
            g.depotSel.set(id, r.id);
            g.toast('機関車を買いました。貨車を買うか、留置線からつないでください', 'good');
          }
          break;
        }
        case 'orders':
          if (sel >= 0) openOrders(g, sel);
          break;
        case 'disband':
          if (sel >= 0 && g.result(disbandTrain(w, sel))) {
            g.wm.close(`train-${sel}`);
            g.wm.close(`orders-${sel}`);
          }
          break;
        case 'selltrain':
          if (sel >= 0 && g.result(sellTrain(w, sel))) {
            g.wm.close(`train-${sel}`);
            g.wm.close(`orders-${sel}`);
          }
          break;
        case 'clone':
          if (g.tool === 'clone') g.setTool('none');
          else g.startClone(id);
          break;
      }
      g.wm.refreshAll();
    },
    onChange: (el) => {
      if (el.dataset.key === 'share') g.cloneShare = (el as HTMLInputElement).checked;
    },
    onClose: () => {
      if (g.tool === 'clone' && g.cloneDepot === id) g.setTool('none');
    },
  });
}

// ───────────────────────── 駅 ─────────────────────────

export function openStation(g: Game, id: number) {
  g.selectStation(id);
  g.wm.open({
    id: `station-${id}`,
    rename: {
      get: () => g.world.stations.get(id)?.name ?? '',
      set: (name) => {
        const ok = g.result(rename(g.world, 'station', id, name));
        g.wm.refreshAll();
        return ok;
      },
    },
    get title() {
      return g.world.stations.get(id)?.name ?? '駅';
    },
    width: 320,
    render: () => {
      const st = g.world.stations.get(id);
      if (!st) return '<p class="muted">この駅はもうありません</p>';
      const acc = stationAccepts(g.world, st);
      const rows = CARGOS.map((c) => {
        const gd = st.goods[c];
        if (!gd.visited && gd.waiting < 1) return '';
        return `<tr><th><span class="cargo-dot ${c}"></span>${CARGO_SPECS[c].name}</th>
          <td class="num">${n0(gd.waiting)}${CARGO_SPECS[c].unit}</td>
          <td>${gauge(gd.rating, 255, gd.rating < 100 ? 'bad' : gd.rating < 160 ? 'mid' : 'good')}</td>
          <td class="num">${pct(gd.rating / 255)}</td></tr>`;
      }).join('');
      return `
        <h4>待っている貨物と駅の評価</h4>
        ${rows ? `<table class="tbl">${rows}</table>` : '<p class="muted small">まだ列車が来ていません。列車が一度積みに来ると、貨物が集まり始めます。</p>'}
        <h4>受け入れる貨物</h4>
        <p>${acc.length ? acc.map((c) => `<span class="tag"><span class="cargo-dot ${c}"></span>${CARGO_SPECS[c].name}</span>`).join('') : '<span class="muted">なし</span>'}</p>
        <p class="muted small">評価は「列車が来る頻度・待っている量・列車の速さ」で決まります。評価が高いほど多くの貨物が駅に来ます。</p>
        ${stationTrainsSection(g, st.id)}`;
    },
    onAction: (a, el) => {
      if (a === 'train') openTrain(g, Number(el.dataset.id));
      if (a === 'replace') g.startReplace(id, [Number(el.dataset.ol)]);
      if (a === 'replace-all') g.startReplace(id);
    },
    onClose: () => {
      if (g.selectedStation === id) g.selectStation(-1);
    },
  });
}

/** この駅に止まる列車（指令を共有している列車はまとめる）と、代わりの駅への差し替え */
function stationTrainsSection(g: Game, stationId: number): string {
  const groups = stationTrains(g.world, stationId);
  if (!groups.length) return '<h4>この駅に止まる列車</h4><p class="muted small">ありません</p>';
  const rows = groups
    .map((gr) => {
      const names = gr.trains.map((t) => `<button class="link" data-action="train" data-id="${t.id}">${esc(t.name)}</button>`).join('・');
      const stops = g.world.orderLists.get(gr.orderList)!.orders.map((o) => g.world.stations.get(o.station)?.name ?? '?');
      return `<li class="st-train"><div>${names}${gr.trains.length > 1 ? `<small class="muted">（指令を共有）</small>` : ''}
          <div class="muted small ellipsis">${esc(stops.join(' → '))}</div></div>
        <span class="grow"></span><button class="small-btn" data-action="replace" data-ol="${gr.orderList}" title="この駅の代わりに、別の駅へ行くようにする">代わりの駅へ</button></li>`;
    })
    .join('');
  return `<h4>この駅に止まる列車 <small class="muted">${groups.reduce((n, gr) => n + gr.trains.length, 0)}本</small></h4>
    <ul class="list">${rows}</ul>
    <div class="btnrow"><button data-action="replace-all"><span>すべての列車の行き先を差し替え</span></button></div>
    <p class="muted small">「代わりの駅へ」を押して地図の駅を選ぶと、指令の中のこの駅がその駅に置きかわります（駅を解体する前に便利です）。</p>`;
}

// ───────────────────────── 産業 ─────────────────────────

export function openIndustry(g: Game, id: number) {
  g.wm.open({
    id: `industry-${id}`,
    rename: {
      get: () => g.world.industries.get(id)?.name ?? '',
      set: (name) => {
        const ok = g.result(rename(g.world, 'industry', id, name));
        g.wm.refreshAll();
        return ok;
      },
    },
    get title() {
      return g.world.industries.get(id)?.name ?? '産業';
    },
    width: 340,
    render: () => {
      const ind = g.world.industries.get(id);
      if (!ind) return '';
      const spec = INDUSTRY_SPECS[ind.type];
      const cap = INDUSTRY.stockCap;
      const out = CARGO_SPECS[spec.output];
      const tr = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0;
      const chain = spec.inputs.length
        ? `${spec.inputs.map((c) => cargoTag(c)).join(' ＋ ')} → ${cargoTag(spec.output)}`
        : `→ ${cargoTag(spec.output)}`;
      const inputs = spec.inputs
        .map((c) => {
          const v = ind.inputs[c] ?? 0;
          const df = demandFactor(v);
          return `<div class="stock"><span>${CARGO_SPECS[c].name}</span>${gauge(v, cap, v > cap * 0.8 ? 'bad' : '')}<span class="num">${n0(v)}/${cap}t</span></div>
            <p class="small indent">買取係数 <b class="${df >= 1 ? 'pos' : 'neg'}">×${df.toFixed(2)}</b></p>`;
        })
        .join('');
      const lacking = spec.inputs.length > 1 ? spec.inputs.filter((c) => (ind.inputs[c] ?? 0) < 1) : [];
      const full = ind.outStock > cap * 0.95;
      const status = industryStatus(g.world, ind);
      return `
        <div class="ind-status ${status.tone}"><i></i>${esc(status.text)}</div>
        ${ownerSection(g, ind)}
        ${boomBox(g, { kind: 'industry', id })}
        <p class="chain">${chain}</p>
        <p class="lead">${esc(spec.desc)}</p>
        ${spec.inputs.length ? `<h4>材料の在庫 <small class="muted">少ないほど高く買います</small></h4>${inputs}` : ''}
        ${lacking.length && spec.inputs.some((c) => (ind.inputs[c] ?? 0) >= 1) ? `<p class="warn small">${lacking.map((c) => CARGO_SPECS[c].name).join('・')}が足りないので動いていません。</p>` : ''}
        <h4>製品</h4>
        <div class="stock"><span>${out.name}</span>${gauge(ind.outStock, cap, full ? 'bad' : '')}<span class="num">${n0(ind.outStock)}/${cap}t</span></div>
        ${full ? `<p class="warn small">${out.name}の置き場がいっぱいで、生産が止まっています。運び出してください。</p>` : ''}
        <dl class="stats">
          <dt>${spec.inputs.length ? '加工能力' : '生産量'}</dt><dd>${n0(ind.prodRate)}t/月</dd>
          ${spec.inputs.length ? `<dt>先月の受け入れ</dt><dd>${n0(ind.receivedLastMonth)}t</dd>` : ''}
          <dt>先月の${spec.inputs.length ? '加工' : '生産'}</dt><dd>${n0(ind.producedLastMonth)}t（輸送率 ${pct(tr)}）</dd>
        </dl>
        ${spec.inputs.length ? '' : '<p class="muted small">輸送率（運び出された割合）が高いほど、生産量が増えやすくなります。</p>'}
        <h4>毎月の${spec.inputs.length ? '受け入れ・加工' : '生産'}と運び出し</h4>
        ${lineChart(
          [
            ...(spec.inputs.length ? [{ name: '受け入れ（材料）', color: '#8b5a2b', data: ind.hist.r, dashed: true }] : []),
            { name: spec.inputs.length ? '加工' : '生産', color: '#2c4a3e', data: ind.hist.p },
            { name: '運び出し', color: '#d8a32a', data: ind.hist.t },
          ],
          { format: (v) => `${Math.round(v)}t`, xLeft: monthsAgo(Math.max(ind.hist.p.length, 1)), xRight: '先月' },
        )}`;
    },
    onAction: (a) => {
      if (a === 'buy') g.result(buyRights(g.world, id));
      if (a === 'contract') g.result(signContract(g.world, id));
      if (a === 'expand') g.result(expandIndustry(g.world, id));
      g.wm.refreshAll();
    },
  });
}

const STATUS_SHORT: Record<string, string> = {
  ok: '順調',
  low: '少なめ',
  unserved: '運び出しなし',
  full: '満杯',
  lacking: '材料不足',
  idle: '材料なし',
  locked: '運べない',
  building: '建設中',
};

/** 持ち主と、権利の購入・輸送契約・増産 */
function ownerSection(g: Game, ind: Industry): string {
  const w = g.world;
  const label = ownerLabel(w, ind);
  const badge = `<span class="owner-badge ${label === '自社' ? 'own' : label === '他社' ? 'other' : label === '契約中' ? 'contract' : label === '建設中' ? 'building' : 'public'}">${label}</span>`;
  if (ind.status === 'building') {
    const left = Math.max(0, ind.readyDay - w.day);
    return `<div class="owner-box">${badge}<span class="small">完成まであと${left}日</span></div>`;
  }
  const btn = (action: string, text: string, cost: number, title = '') =>
    `<button data-action="${action}" ${cost > w.money ? 'disabled' : ''} title="${esc(title)}"><span>${text} ${formatYen(cost)}</span></button>`;
  if (ind.owner === 'player') {
    return `<div class="owner-box">${badge}<span class="small">先月の利益 <b class="pos">${formatYen(ind.dividendLastMonth)}</b>・維持費 ${formatYen(upkeepPerMonth(ind))}/月</span></div>
      <div class="btnrow">${ind.prodRate < 400 ? btn('expand', `増産（×${INDUSTRY_ECON.expandFactor}）`, expandCost(ind)) : ''}</div>`;
  }
  if (ind.owner === 'public') {
    return `<div class="owner-box">${badge}<span class="small">地元の産業です。だれでも運べます。権利を買うと、運んだ分の利益も入ります。</span></div>
      <div class="btnrow">${btn('buy', '権利を買う', rightsPrice(ind))}</div>`;
  }
  const contracted = ind.contractUntil > w.day;
  const left = contracted ? ind.contractUntil - w.day : 0;
  const cond = `毎月${Math.round(INDUSTRY_ECON.contractMinRate * 100)}%以上運び出す`;
  return `<div class="owner-box">${badge}<span class="small">${
    contracted
      ? `輸送契約：残り${left}日・条件「${cond}」${ind.contractStrikes ? `<b class="neg">（守れなかった月 ${ind.contractStrikes}/${INDUSTRY_ECON.contractMaxStrikes}）</b>` : ''}`
      : '他社の産業です。<b>権利を買うか、輸送契約を結ぶと運べます。</b>'
  }</span></div>
    <div class="btnrow">
      ${!contracted || left <= 180 ? btn('contract', contracted ? '契約を更新' : `輸送契約（${Math.round(INDUSTRY_ECON.contractDays / 365)}年）`, contractFee(ind), `条件：${cond}。${INDUSTRY_ECON.contractMaxStrikes}か月続けて守れないと打ち切り`) : ''}
      ${btn('buy', '権利を買う', rightsPrice(ind))}
    </div>`;
}

function cargoTag(c: Cargo): string {
  return `<span class="tag"><span class="cargo-dot ${c}"></span>${CARGO_SPECS[c].name}</span>`;
}

// ───────────────────────── 町 ─────────────────────────

/** その場所で起きているブーム */
function boomBox(g: Game, target: Boom['target']): string {
  const list = activeBooms(g.world).filter((b) => b.target.kind === target.kind && b.target.id === target.id);
  if (!list.length) return '';
  return list
    .map(
      (b) =>
        `<div class="boom-box"><b>${BOOM_LABEL[b.kind]}</b><span>${b.cargo === 'passengers' ? 'この町へ来る旅客の運賃' : `${CARGO_SPECS[b.cargo].name}の買取`} ×${b.mul.toFixed(1)}${b.kind === 'tourism' ? '・旅客も増える' : ''}</span><small>あと${Math.max(0, b.until - g.world.day)}日</small></div>`,
    )
    .join('');
}

/** 町のウィンドウ：名産と評判 */
function specialtyRow(g: Game, t: Town): string {
  const ws = workshopOf(g.world, t.id);
  if (!ws?.specialty) return '';
  const fame = t.fame ?? 0;
  const stars = fame >= 900 ? '★★★' : fame >= 300 ? '★★☆' : fame >= 50 ? '★☆☆' : '☆☆☆';
  const mul = famePaxMul(t);
  return `<dt>名産</dt><dd><b>${SPECIALTIES[ws.specialty].name}</b>（<button class="link" data-action="goto-ws" data-id="${ws.id}">${esc(ws.name)}</button>）</dd>
          <dt>名産の評判</dt><dd><span class="ch-stars got">${stars}</span>${mul > 1.005 ? ` 観光客 ×${mul.toFixed(2)}` : ' <span class="muted small">運び出すと上がる</span>'}</dd>`;
}

export function openTown(g: Game, id: number) {
  g.wm.open({
    id: `town-${id}`,
    rename: {
      get: () => (g.world.towns.has(id) ? townLabel(g.world.towns.get(id)!) : ''),
      set: (name) => {
        const ok = g.result(rename(g.world, 'town', id, name));
        g.wm.refreshAll();
        return ok;
      },
    },
    get title() {
      return `${g.world.towns.has(id) ? townLabel(g.world.towns.get(id)!) : ''}`;
    },
    width: 320,
    onAction: (a, el) => {
      if (a === 'goto-ws') {
        const ind = g.world.industries.get(Number(el.dataset.id));
        if (ind) {
          g.renderer.centerOnTile(ind.x + 1, ind.y + 1);
          openIndustry(g, ind.id);
        }
      }
    },
    render: () => {
      const t = g.world.towns.get(id);
      if (!t) return '';
      const goods = TOWN_GOODS.map((c) => {
        const r = t.recv[c];
        const ok = townAccepts(g.world, id, c);
        return `<tr class="${ok ? '' : 'off'}"><th>${cargoTag(c)}</th><td class="num">${n0(r?.lm ?? 0)}t</td><td class="num">${ok ? `${n0(t.stock[c] ?? 0)}t` : '—'}</td><td class="num">${ok ? `×${acceptorDemand(g.world, { kind: 'town', id }, c).toFixed(2)}` : '<span class="muted small">受け入れない</span>'}</td></tr>`;
      }).join('');
      const stage = townStage(t);
      const next = STAGES[stage + 1];
      const STAGE_NOTE = [
        '木材で平屋が建ちます。1,000人で「町」になります。',
        '木材で家とアパート、建設資材でビルが建ちます（ビルは家の2割まで）。5,000人で「都市」になり、木材は受け入れなくなります。',
        '建設資材でビルが建ちます。木材はもう受け入れません。',
      ];
      return `
        ${boomBox(g, { kind: 'town', id })}
        <div class="stage-box s${stage}"><b>${stageName(t)}</b><span>${STAGE_NOTE[stage]}</span>${next ? `<small>「${next.name}」まであと ${n0(Math.max(0, next.minPop - t.population))}人</small>` : ''}</div>
        <dl class="stats">
          <dt>人口</dt><dd><b>${n0(t.population)}人</b></dd>
          <dt>建物</dt><dd>${t.houses}軒</dd>
          <dt>使われている駅</dt><dd>${t.activeStations}駅 ${t.activeStations === 0 ? '<span class="muted">（成長がとても遅い）</span>' : '<span class="pos">（成長中）</span>'}</dd>
          <dt>食料品</dt><dd>${t.fed ? '<span class="pos">足りている（早く育つ）</span>' : '<span class="muted">足りない</span>'}</dd>
          <dt>届いた旅客（先月）</dt><dd>${n0(t.recv.passengers?.lm ?? 0)}人</dd>
          <dt>都市間の旅客</dt><dd>同じ大きさの町と結ぶと運賃 <b>×${intercityMul(t, { ...t, id: -1 }).toFixed(2)}</b></dd>
          ${specialtyRow(g, t)}
        </dl>
        <table class="tbl"><tr><th></th><th class="num">先月届いた</th><th class="num">在庫</th><th class="num">買取</th></tr>${goods}</table>
        <p class="muted small">食料品が足りていると町が早く育ちます。駅がよく使われているほど成長が速くなります。大きな町ほど、ふだんの成長はゆっくりになります。</p>
        <h4>人口の移り変わり</h4>
        ${lineChart([{ name: '人口', color: '#2c4a3e', data: t.popHist ?? [] }], {
          height: 100,
          xLeft: monthsAgo(Math.max(1, t.popHist?.length ?? 0)),
          xRight: '先月',
        })}`;
    },
  });
}

// ───────────────────────── 会社のランクと実績 ─────────────────────────

export function openCompany(g: Game) {
  g.wm.open({
    id: 'company',
    title: '会社と実績',
    width: 400,
    rename: {
      get: () => companyName(g.world),
      set: (name) => {
        const ok = g.result(renameCompany(g.world, name));
        if (ok) g.updateHud();
        return ok;
      },
    },
    render: () => {
      const w = g.world;
      const r = rankIndex(w);
      const value = companyValue(w);
      const pop = connectedPopulation(w);
      const next = RANKS[r + 1];
      const bar = (cur: number, goal: number) => `<span class="gauge"><i style="width:${Math.max(0, Math.min(100, (cur / goal) * 100)).toFixed(0)}%"></i></span>`;
      const ladder = RANKS.map((k, i) => `<li class="${i < r ? 'done' : i === r ? 'cur' : ''}">${k.name}</li>`).join('');
      const got = ACHIEVEMENTS.filter((a) => w.achievements?.[a.id] !== undefined).length;
      const list = ACHIEVEMENTS.map((a) => {
        const day = w.achievements?.[a.id];
        return day !== undefined
          ? `<li class="ach got"><b>★ ${esc(a.name)}</b><small>${achievedLabel(day)}</small></li>`
          : `<li class="ach"><b>☆ ${esc(a.name)}</b><small>${esc(a.hint)}</small></li>`;
      }).join('');
      return `
        <div class="rank-card">
          <p class="company-name"><b>${esc(companyName(w))}</b> <small class="muted">（タイトルの鉛筆で名前を変えられます）</small></p>
          <p class="muted small">会社のランク</p>
          <p class="rank-name">${RANKS[r].name}</p>
          <ol class="rank-ladder">${ladder}</ol>
          ${
            next
              ? `<p class="small">次は「<b>${next.name}</b>」：</p>
                 <div class="rank-goal"><span>会社の価値</span>${bar(value, next.value)}<span class="num">${formatYen(value)} / ${formatYen(next.value)}</span></div>
                 <div class="rank-goal"><span>つないだ町の人口</span>${bar(pop, next.pop)}<span class="num">${n0(pop)} / ${n0(next.pop)}人</span></div>
                 <p class="muted small">ランクが上がると、借入の上限が ${formatYen(next.maxLoan)} になります。会社の価値は、お金 − 借入 ＋ 車両 ＋ 自社の産業 です。</p>`
              : '<p class="pos">いちばん上のランクです！</p>'
          }
        </div>
        <h4>実績 <small class="muted">${got} / ${ACHIEVEMENTS.length}</small></h4>
        <ul class="ach-list">${list}</ul>`;
    },
  });
}

// ───────────────────────── 財務 ─────────────────────────

const FIN_LABELS: Record<FinanceCategory, string> = {
  construction: '建設費',
  vehicles: '車両の購入・売却',
  industry: '産業（権利・契約・探鉱・建設）',
  running: '列車の維持費',
  facilities: '車庫・産業の維持費',
  income: '運賃収入',
  dividends: '自社の産業の利益',
  rewards: '依頼の報酬',
  devel: '自社開発（開発費・販売）',
  interest: '借入金の利息',
};

export function openFinance(g: Game) {
  g.wm.open({
    id: 'finance',
    title: '財務',
    width: 360,
    render: () => {
      const w = g.world;
      const sum = (r: Record<FinanceCategory, number>) => FINANCE_CATEGORIES.reduce((s, k) => s + r[k], 0);
      const y = new Date(Date.UTC(1960, 0, 1) + w.day * 86400000).getUTCFullYear();
      return `
        <div class="rank-line"><span class="muted small">会社のランク</span><b>${RANKS[rankIndex(w)].name}</b><span class="grow"></span><button class="small-btn" data-action="company">${ICONS.trophy}会社と実績</button></div>
        <table class="tbl fin">
          <tr><th></th><th class="num">${y}年</th><th class="num">${y - 1}年</th></tr>
          ${FINANCE_CATEGORIES.map((k) => `<tr><th>${FIN_LABELS[k]}</th><td class="num ${w.finance.thisYear[k] < 0 ? 'neg' : 'pos'}">${formatYen(w.finance.thisYear[k])}</td><td class="num">${formatYen(w.finance.lastYear[k])}</td></tr>`).join('')}
          <tr class="total"><th>合計</th><td class="num ${sum(w.finance.thisYear) < 0 ? 'neg' : 'pos'}">${formatYen(sum(w.finance.thisYear))}</td><td class="num">${formatYen(sum(w.finance.lastYear))}</td></tr>
        </table>
        <dl class="stats">
          <dt>所持金</dt><dd><b>${formatYen(w.money)}</b></dd>
          <dt>借入金</dt><dd>${formatYen(w.loan)} <span class="muted">／ 上限 ${formatYen(w.maxLoan)}</span></dd>
          <dt>金利</dt><dd>年 ${w.interestRate}%</dd>
        </dl>
        <div class="btnrow">
          <button data-action="borrow" ${w.loan >= w.maxLoan ? 'disabled' : ''}><span>借りる ＋${formatYen(FINANCE.loanStep)}</span></button>
          <button data-action="repay" ${w.loan <= 0 ? 'disabled' : ''}><span>返す −${formatYen(FINANCE.loanStep)}</span></button>
        </div>
        ${financeCharts(g)}`;
    },
    onAction: (a) => {
      if (a === 'company') return openCompany(g);
      if (a === 'borrow') g.result(borrow(g.world));
      if (a === 'repay') g.result(repay(g.world));
      g.wm.refreshAll();
    },
  });
}

// ───────────────────────── 一覧 ─────────────────────────

// 並べ替え・絞り込み（ウィンドウを閉じても、遊んでいる間は覚えておく）
const listState = new Map<string, { sort: string; filter: string }>();

function listCtl(id: string, sorts: [string, string][], filters: [string, string][] = []) {
  const st = listState.get(id) ?? { sort: sorts[0][0], filter: filters[0]?.[0] ?? 'all' };
  listState.set(id, st);
  const opt = (list: [string, string][], cur: string) => list.map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  const html = `<div class="list-ctl">
      <label>並べ方<select data-key="sort">${opt(sorts, st.sort)}</select></label>
      ${filters.length ? `<label>表示<select data-key="filter">${opt(filters, st.filter)}</select></label>` : ''}
    </div>`;
  return { ...st, html };
}

function listChange(g: Game, id: string, el: HTMLInputElement | HTMLSelectElement) {
  const st = listState.get(id);
  if (!st) return;
  if (el.dataset.key === 'sort') st.sort = el.value;
  if (el.dataset.key === 'filter') st.filter = el.value;
  g.wm.refresh(id, true);
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, 'ja');
const emptyFilter = '<p class="muted small">この条件に合うものはありません。</p>';

export function openTrainList(g: Game) {
  g.wm.open({
    id: 'trains',
    title: '列車一覧',
    width: 400,
    render: () => {
      let list = [...g.world.trains.values()];
      if (!list.length) return '<p class="muted">列車がありません。車庫をクリックして列車を買いましょう。</p>';
      const c = listCtl(
        'trains',
        [
          ['id', '買った順'],
          ['profit', '今年の利益が多い順'],
          ['loss', '今年の利益が少ない順'],
          ['month', '先月の利益が多い順'],
          ['name', '名前順'],
        ],
        [
          ['all', 'すべて'],
          ['red', '先月赤字の列車'],
          ['stopped', '止まっている列車'],
          ['moving', '走っている列車'],
        ],
      );
      const last = (t: Train) => t.hist.at(-1) ?? 0;
      const stopped = (t: Train) => t.state === 'in_depot' || t.state === 'stopped' || t.state === 'no_path';
      if (c.filter === 'red') list = list.filter((t) => last(t) < 0);
      if (c.filter === 'stopped') list = list.filter(stopped);
      if (c.filter === 'moving') list = list.filter((t) => !stopped(t));
      if (c.sort === 'profit') list.sort((a, b) => b.profitThisYear - a.profitThisYear);
      if (c.sort === 'loss') list.sort((a, b) => a.profitThisYear - b.profitThisYear);
      if (c.sort === 'month') list.sort((a, b) => last(b) - last(a));
      if (c.sort === 'name') list.sort(byName);
      return `${c.html}${list.length ? '' : emptyFilter}<ul class="list">${list
        .map((t) => {
          const s = trainStatus(g, t);
          return `<li data-action="open" data-id="${t.id}" class="clickable"><b>${esc(t.name)}</b><span class="small ${s.tone === 'bad' ? 'neg' : 'muted'} ellipsis">${esc(s.text.replace(' — クリックで発車', ''))}</span><span class="grow"></span>${sparkline(t.hist.slice(-12), last(t) >= 0 ? '#2f8a4a' : '#c0443a')}<span class="num ${t.profitThisYear >= 0 ? 'pos' : 'neg'}">${formatYen(t.profitThisYear)}</span></li>`;
        })
        .join('')}</ul>`;
    },
    onAction: (a, el) => {
      if (a === 'open') openTrain(g, Number(el.dataset.id));
    },
    onChange: (el) => listChange(g, 'trains', el),
  });
}

export function openStationList(g: Game) {
  g.wm.open({
    id: 'stations',
    title: '駅一覧',
    width: 360,
    render: () => {
      let list = [...g.world.stations.values()];
      if (!list.length) return '<p class="muted">駅がありません。鉄道建設ツールの「駅」で作れます。</p>';
      const c = listCtl(
        'stations',
        [
          ['id', '建てた順'],
          ['waiting', '待っている荷物が多い順'],
          ['rating', '評価が低い順'],
          ['name', '名前順'],
        ],
        [
          ['all', 'すべて'],
          ['waiting', '荷物が待っている駅'],
          ['unused', '列車が来ていない駅'],
        ],
      );
      const waitSum = (st: Station) => CARGOS.reduce((n, k) => n + st.goods[k].waiting, 0);
      const rating = (st: Station) => {
        const r = CARGOS.filter((k) => st.goods[k].visited).map((k) => st.goods[k].rating);
        return r.length ? Math.min(...r) : 999;
      };
      const unused = (st: Station) => stationTrains(g.world, st.id).length === 0;
      if (c.filter === 'waiting') list = list.filter((st) => waitSum(st) >= 1);
      if (c.filter === 'unused') list = list.filter(unused);
      if (c.sort === 'waiting') list.sort((a, b) => waitSum(b) - waitSum(a));
      if (c.sort === 'rating') list.sort((a, b) => rating(a) - rating(b));
      if (c.sort === 'name') list.sort(byName);
      return `${c.html}${list.length ? '' : emptyFilter}<ul class="list">${list
        .map((st) => {
          const waiting = CARGOS.filter((k) => st.goods[k].waiting >= 1)
            .map((k) => `<span class="tag"><span class="cargo-dot ${k}"></span>${n0(st.goods[k].waiting)}${CARGO_SPECS[k].unit}</span>`)
            .join('');
          const r = rating(st);
          return `<li data-action="open" data-id="${st.id}" class="clickable"><b>${esc(st.name)}</b>${r < 999 ? `<span class="small muted">評価 ${pct(r / 255)}</span>` : ''}<span class="grow"></span>${waiting}</li>`;
        })
        .join('')}</ul>`;
    },
    onAction: (a, el) => {
      if (a === 'open') {
        const st = g.world.stations.get(Number(el.dataset.id));
        if (st) {
          const s = stationSign(st);
          g.renderer.centerOnTile(tx(g.world, s), ty(g.world, s));
          openStation(g, st.id);
        }
      }
    },
    onChange: (el) => listChange(g, 'stations', el),
  });
}

const TONE_ORDER: Record<string, number> = { bad: 0, warn: 1, mute: 2, good: 3 };

export function openIndustryList(g: Game) {
  g.wm.open({
    id: 'industries',
    title: '産業一覧',
    width: 380,
    render: () => {
      const w = g.world;
      const c = listCtl(
        'industries',
        [
          ['id', '見つかった順'],
          ['status', '困っている順'],
          ['rate', '運び出しが少ない順'],
          ['type', '種類順'],
          ['name', '名前順'],
        ],
        [
          ['all', 'すべて'],
          ['own', '自社の産業'],
          ['usable', '運び出せる産業'],
          ['trouble', '順調でない産業'],
          ['primary', '一次産業（森・農場・鉱山）'],
          ['factory', '工場'],
        ],
      );
      const rate = (ind: Industry) => (ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0);
      const types = Object.keys(INDUSTRY_SPECS);
      let list = [...w.industries.values()].map((ind) => ({ ind, stt: industryStatus(w, ind), ol: ownerLabel(w, ind), name: ind.name }));
      if (c.filter === 'own') list = list.filter((x) => x.ind.owner === 'player');
      if (c.filter === 'usable') list = list.filter((x) => canLoadFrom(w, x.ind));
      if (c.filter === 'trouble') list = list.filter((x) => x.stt.code !== 'ok');
      if (c.filter === 'primary') list = list.filter((x) => isPrimary(x.ind.type));
      if (c.filter === 'factory') list = list.filter((x) => !isPrimary(x.ind.type));
      if (c.sort === 'status') list.sort((a, b) => (TONE_ORDER[a.stt.tone] ?? 2) - (TONE_ORDER[b.stt.tone] ?? 2));
      if (c.sort === 'rate') list.sort((a, b) => rate(a.ind) - rate(b.ind));
      if (c.sort === 'type') list.sort((a, b) => types.indexOf(a.ind.type) - types.indexOf(b.ind.type));
      if (c.sort === 'name') list.sort(byName);
      return `${c.html}${list.length ? '' : emptyFilter}<ul class="list">${list
        .map(({ ind, stt, ol }) => {
          return `<li data-action="open" data-id="${ind.id}" class="clickable"><span class="owner-badge ${ol === '自社' ? 'own' : ol === '他社' ? 'other' : ol === '契約中' ? 'contract' : ol === '建設中' ? 'building' : 'public'}">${ol}</span><b>${esc(ind.name)}</b><span class="muted small">${INDUSTRY_SPECS[ind.type].inputs.map((k) => CARGO_SPECS[k].name).join('＋')}${INDUSTRY_SPECS[ind.type].inputs.length ? '→' : ''}${CARGO_SPECS[INDUSTRY_SPECS[ind.type].output].name}</span><span class="grow"></span><span class="ind-st ${stt.tone}" title="${esc(stt.text)}"><i></i>${STATUS_SHORT[stt.code]}</span><span class="small muted">${pct(rate(ind))}</span></li>`;
        })
        .join('')}</ul>
       <p class="muted small">森→製材所→木材（町に家）／農場→食品工場→食料品（町が早く育つ）／鉄鉱山＋炭鉱→製鉄所→鋼材／木材＋鋼材→建材工場→建設資材（町に高層ビル）</p>`;
    },
    onAction: (a, el) => {
      if (a === 'open') {
        const ind = g.world.industries.get(Number(el.dataset.id))!;
        g.renderer.centerOnTile(ind.x + 1, ind.y + 1);
        openIndustry(g, ind.id);
      }
    },
    onChange: (el) => listChange(g, 'industries', el),
  });
}

export function openTownList(g: Game) {
  g.wm.open({
    id: 'towns',
    title: '町一覧',
    width: 320,
    render: () => {
      const c = listCtl('towns', [
        ['pop', '人口が多い順'],
        ['growth', '先月よく育った順'],
        ['name', '名前順'],
      ]);
      const growth = (t: Town) => {
        const h = t.popHist ?? [];
        return h.length >= 2 ? h[h.length - 1] - h[h.length - 2] : 0;
      };
      const list = [...g.world.towns.values()].map((t) => ({ t, name: townLabel(t) }));
      if (c.sort === 'pop') list.sort((a, b) => b.t.population - a.t.population);
      if (c.sort === 'growth') list.sort((a, b) => growth(b.t) - growth(a.t));
      if (c.sort === 'name') list.sort(byName);
      return `${c.html}<ul class="list">${list
        .map(({ t, name }) => {
          const d = growth(t);
          return `<li data-action="open" data-id="${t.id}" class="clickable"><span class="stage-tag s${townStage(t)}">${stageName(t)}</span><b>${esc(name)}</b>${(t.popHist?.length ?? 0) > 1 ? sparkline(t.popHist!.slice(-12), '#2c4a3e') : ''}<span class="grow"></span>${d ? `<span class="small ${d > 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${n0(d)}</span>` : ''}<span class="num">${n0(t.population)}人</span></li>`;
        })
        .join('')}</ul>`;
    },
    onAction: (a, el) => {
      if (a === 'open') {
        const t = g.world.towns.get(Number(el.dataset.id))!;
        g.renderer.centerOnTile(t.cx, t.cy);
        openTown(g, t.id);
      }
    },
    onChange: (el) => listChange(g, 'towns', el),
  });
}

// ───────────────────────── ヘルプ・メニュー ─────────────────────────

export type HelpTab = 'keys' | 'manual' | 'notes';
let helpTab: HelpTab = 'keys';

const HELP_TABS: [HelpTab, string][] = [
  ['keys', '操作方法'],
  ['manual', '取扱説明書'],
  ['notes', 'リリースノート'],
];

export function openHelp(g: Game, tab?: HelpTab) {
  if (tab) helpTab = tab;
  g.wm.open({
    id: 'help',
    title: 'ヘルプ',
    width: 480,
    render: () => `
      <div class="tabs" role="tablist">
        ${HELP_TABS.map(([k, v]) => `<button role="tab" data-action="tab-${k}" class="${helpTab === k ? 'on' : ''}">${v}</button>`).join('')}
      </div>
      <div class="help">${helpTab === 'manual' ? manualHtml() : helpTab === 'notes' ? releaseNotesHtml(g.prevVersion) : helpKeysHtml(g)}</div>`,
    onAction: (a, el) => {
      if (a.startsWith('tab-')) {
        helpTab = a.slice(4) as HelpTab;
        const body = el.closest('.win-body');
        g.wm.refresh('help', true);
        if (body) body.scrollTop = 0;
        return;
      }
      if (a.startsWith('pace-') && g.world) {
        g.world.pace = a.slice(5) as Pace;
        g.toast(`時間の流れを「${PACES[g.world.pace].name}」にしました`, 'info');
      }
      if (a === 'ui-auto') g.setUiPref('auto');
      if (a === 'ui-pc') g.setUiPref('pc');
      if (a === 'ui-touch') g.setUiPref('touch');
      g.wm.refresh('help', true);
    },
  });
}

function helpKeysHtml(g: Game): string {
  return `${KEYS_HTML}
        <p class="muted small">試作版 v${VERSION} です。信号・橋とトンネルのツール・地形変更はまだありません。列車どうしはぶつかりません。遊び方は「取扱説明書」、これまでの変更は「リリースノート」をどうぞ。</p>
        <h4>画面</h4>
        <div class="btnrow">
          <button data-action="ui-auto" class="${g.uiPref === 'auto' ? 'on' : ''}"><span>自動</span></button>
          <button data-action="ui-pc" class="${g.uiPref === 'pc' ? 'on' : ''}"><span>PC</span></button>
          <button data-action="ui-touch" class="${g.uiPref === 'touch' ? 'on' : ''}"><span>スマホ</span></button>
        </div>
        ${
          g.world && !g.world.challenge
            ? `<h4>時間の流れ <small class="muted">この街の設定・いつでも変えられます</small></h4>
        <div class="btnrow">
          ${(Object.keys(PACES) as Pace[]).map((k) => `<button data-action="pace-${k}" class="${(g.world.pace ?? 'normal') === k ? 'on' : ''}"><span>${PACES[k].name}</span></button>`).join('')}
        </div>
        <p class="muted small">${PACES[g.world.pace ?? 'normal'].desc}。列車の速さは変わりません。</p>`
            : ''
        }`;
}

const KEYS_HTML = `
        <h4>PC（OpenTTD と同じ操作）</h4>
        <table class="tbl keys">
          <tr><th>右ドラッグ</th><td>地図を動かす</td></tr>
          <tr><th>ホイール ／ <kbd>+</kbd> <kbd>-</kbd></th><td>ズーム</td></tr>
          <tr><th>左クリック・ドラッグ</th><td>建設（ツール選択中）／ 情報を見る</td></tr>
          <tr><th><kbd>Ctrl</kbd>＋ドラッグ</th><td>線路の撤去</td></tr>
          <tr><th><kbd>Shift</kbd>＋建設</th><td>費用の見積もりだけ表示</td></tr>
          <tr><th><kbd>Shift</kbd>+<kbd>F7</kbd></th><td>鉄道建設ツール</td></tr>
          <tr><th><kbd>A</kbd> <kbd>1</kbd>〜<kbd>4</kbd> ／ <kbd>6</kbd> <kbd>7</kbd> <kbd>9</kbd> ／ <kbd>R</kbd></th><td>線路 ／ 解体・車庫・駅 ／ 撤去の切り替え</td></tr>
          <tr><th><kbd>O</kbd></th><td>1マスの駅の向きを切り替え</td></tr>
          <tr><th><kbd>D</kbd></th><td>解体（どこでも）</td></tr>
          <tr><th><kbd>F3</kbd></th><td>セーブ／ロード</td></tr>
          <tr><th><kbd>Esc</kbd></th><td>ツールを解除</td></tr>
          <tr><th><kbd>Ctrl</kbd>+<kbd>Z</kbd></th><td>元に戻す</td></tr>
          <tr><th><kbd>F1</kbd></th><td>一時停止</td></tr>
          <tr><th><kbd>F5</kbd> <kbd>F7</kbd> <kbd>F8</kbd> <kbd>F12</kbd> <kbd>Shift</kbd>+<kbd>F1</kbd></th><td>町・駅・財務・産業・列車の一覧</td></tr>
          <tr><th><kbd>Delete</kbd></th><td>ウィンドウを閉じる（<kbd>Shift</kbd>で全部）</td></tr>
        </table>
        <h4>スマホ</h4>
        <table class="tbl keys">
          <tr><th>1本指ドラッグ</th><td>地図を動かす（ツール選択中は建設のプレビュー）</td></tr>
          <tr><th>2本指</th><td>動かす・ピンチでズーム</td></tr>
          <tr><th>タップ ／ 長押し</th><td>選ぶ ／ 情報を見る</td></tr>
          <tr><th>✓ ／ ✕</th><td>プレビューを確定 ／ 取り消し</td></tr>
          <tr><th>撤去ボタン</th><td>PC の Ctrl の代わり</td></tr>
        </table>`;

// ───────────────────────── お知らせの履歴 ─────────────────────────

export function openNews(g: Game) {
  g.wm.open({
    id: 'news',
    title: 'お知らせの履歴',
    width: 400,
    render: () => {
      const log = g.newsLog;
      if (!log.length) return '<p class="muted">まだお知らせはありません。</p>';
      return `
        <p class="muted small">新しい順・${log.length}件（この遊んでいる間のぶん）。行を押すとその場所へ移動します。</p>
        <ul class="news-log">
          ${[...log]
            .reverse()
            .map(
              (n, i) => `<li class="${esc(n.tone)}${n.tile >= 0 ? ' link' : ''}" ${n.tile >= 0 ? `data-action="go" data-i="${log.length - 1 - i}"` : ''}>
                <span class="d num">${n.date}</span><span class="t">${esc(n.text)}</span></li>`,
            )
            .join('')}
        </ul>`;
    },
    onAction: (a, el) => {
      if (a === 'go') {
        const n = g.newsLog[Number(el.dataset.i)];
        if (n && n.tile >= 0) g.centerOnTile(n.tile);
      }
    },
  });
}

export function openMenu(g: Game) {
  g.wm.open({
    id: 'menu',
    title: 'メニュー',
    width: 300,
    render: () => `
      <div class="menu-grid">
        <button data-action="finance">${ICONS.money}<span>財務</span></button>
        <button data-action="trains">${ICONS.train}<span>列車一覧</span></button>
        <button data-action="stations">${ICONS.station}<span>駅一覧</span></button>
        <button data-action="industries">${ICONS.industry}<span>産業一覧</span></button>
        <button data-action="requests">${ICONS.request}<span>依頼ボード</span></button>
        <button data-action="market">${ICONS.market}<span>相場表</span></button>
        <button data-action="build-industry">${ICONS.industry}<span>産業をつくる</span></button>
        <button data-action="save">${ICONS.save}<span>セーブ／ロード</span></button>
        <button data-action="towns">${ICONS.depot}<span>町一覧</span></button>
        <button data-action="company">${ICONS.trophy}<span>会社と実績</span></button>
        <button data-action="devel">${ICONS.wrench}<span>自社開発</span></button>
        <button data-action="zukan">${ICONS.book}<span>車両図鑑</span></button>
        <button data-action="news">${ICONS.news}<span>お知らせ</span></button>
        <button data-action="help">${ICONS.help}<span>ヘルプ</span></button>
      </div>`,
    onAction: (a) => {
      g.wm.close('menu');
      if (a === 'finance') openFinance(g);
      if (a === 'trains') openTrainList(g);
      if (a === 'stations') openStationList(g);
      if (a === 'industries') openIndustryList(g);
      if (a === 'towns') openTownList(g);
      if (a === 'requests') openRequests(g);
      if (a === 'market') openMarket(g);
      if (a === 'build-industry') openBuildIndustry(g);
      if (a === 'save') g.openSaveLoad();
      if (a === 'help') openHelp(g);
      if (a === 'news') openNews(g);
      if (a === 'company') openCompany(g);
      if (a === 'zukan') openZukan(g);
      if (a === 'devel') openDevel(g);
    },
  });
}

// ───────────────────────── 依頼ボード ─────────────────────────

export function openRequests(g: Game) {
  g.wm.open({
    id: 'requests',
    title: '依頼ボード',
    width: 380,
    render: () => {
      const w = g.world;
      const st = w.requestState;
      const cards = w.requests
        .map((r) => {
          const left = daysLeft(w, r);
          const ratio = r.goal > 0 ? r.progress / r.goal : 0;
          const prog =
            r.kind === 'connect'
              ? r.progress >= 1
                ? 'つながりました'
                : 'まだつながっていません'
              : r.kind === 'rating'
                ? `いちばん高い駅 ${pct(r.progress / 255)} ／ 目標 70%`
                : r.kind === 'income'
                  ? `${formatYen(r.progress)} ／ ${formatYen(r.goal)}`
                  : `${n0(r.progress)} ／ ${n0(r.goal)}${r.kind === 'population' || r.kind === 'carry_pax' ? '人' : 't'}`;
          return `<li class="req">
            <div class="req-head"><b>${esc(r.title)}</b></div>
            <p class="small">${esc(r.desc)}</p>
            <div class="req-prog">${gauge(r.progress, r.goal, ratio >= 1 ? 'good' : '')}<span class="small">${prog}</span></div>
            <div class="req-foot">
              <span class="reward ${r.reward.kind}">報酬：${esc(rewardText(r.reward))}</span>
              <span class="grow"></span>
              <span class="muted small">${esc(r.from)}・残り${left}日</span>
              ${r.tile >= 0 ? `<button class="small-btn" data-action="goto" data-tile="${r.tile}">${ICONS.center}見る</button>` : ''}
            </div></li>`;
        })
        .join('');
      const unlocked = [...w.unlocked].map((v) => vehicleName(v)).join('・');
      return `
        <ul class="reqs">${cards || '<li class="muted small">今は依頼がありません。しばらくすると届きます。</li>'}</ul>
        <p class="muted small">依頼は達成できなくても大丈夫です（期限が切れると消えるだけ）。報酬の車両は車庫の留置線に届きます。</p>
        <dl class="stats">
          <dt>達成した依頼</dt><dd>${st.completed}件</dd>
          ${unlocked ? `<dt>解禁した車両</dt><dd>${esc(unlocked)}</dd>` : ''}
        </dl>`;
    },
    onAction: (a, el) => {
      if (a === 'goto') {
        const t = Number(el.dataset.tile);
        g.renderer.centerOnTile(tx(g.world, t), ty(g.world, t));
      }
    },
  });
}

// ───────────────────────── 相場表 ─────────────────────────

/** 貨物ごとに、どこがいくらで買うか（在庫が少ないほど高い）。自分の駅で届けられる所に印 */
export function openMarket(g: Game) {
  g.wm.open({
    id: 'market',
    title: '相場表',
    width: 400,
    render: () => {
      const w = g.world;
      const cargos: Cargo[] = CARGOS.filter((c) => c !== 'passengers');
      const sel = g.marketCargo && (cargos as Cargo[]).includes(g.marketCargo) ? g.marketCargo : cargos[0];
      const tabs = cargos
        .map((c) => `<button class="mtab ${c === sel ? 'on' : ''}" data-action="cargo" data-c="${c}"><span class="cargo-dot ${c}"></span>${CARGO_SPECS[c].name}</button>`)
        .join('');
      // 自分の駅で届けられる受け入れ先
      const served = new Set<string>();
      for (const st of w.stations.values()) for (const a of acceptors(w, st, sel)) served.add(`${a.kind}:${a.id}`);
      type Row = { kind: 'industry' | 'town'; id: number; name: string; stock: number; cap: number; demand: number; tile: number };
      const rows: Row[] = [];
      for (const ind of w.industries.values()) {
        if (!INDUSTRY_SPECS[ind.type].inputs.includes(sel)) continue;
        const a = { kind: 'industry' as const, id: ind.id };
        rows.push({ ...a, name: ind.name, stock: acceptorStock(w, a, sel), cap: INDUSTRY.stockCap, demand: acceptorDemand(w, a, sel), tile: ind.y * w.w + ind.x });
      }
      if (TOWN_GOODS.includes(sel)) {
        for (const t of w.towns.values()) {
          if (!townAccepts(w, t.id, sel)) continue;
          const a = { kind: 'town' as const, id: t.id };
          rows.push({ ...a, name: `${townLabel(t)}`, stock: acceptorStock(w, a, sel), cap: TOWN.stockCap, demand: acceptorDemand(w, a, sel), tile: t.cy * w.w + t.cx });
        }
      }
      rows.sort((p, q) => q.demand - p.demand);
      const boomed = new Set(activeBooms(w).filter((b) => b.cargo === sel).map((b) => `${b.target.kind}:${b.target.id}`));
      const producers = [...w.industries.values()].filter((i) => INDUSTRY_SPECS[i.type].output === sel);
      const spec = CARGO_SPECS[sel];
      return `
        <div class="mtabs">${tabs}</div>
        ${boomList(g)}
        <p class="small">基本運賃 <b>${formatYen(spec.rate * 10)}</b>/t（10マスあたり）・${spec.days1}日までは満額${spec.days1 <= 8 ? '<span class="warn">（傷みやすい）</span>' : ''}</p>
        <p class="small">いまの相場 <b class="num ${marketIndex(w, sel) >= 1 ? 'pos' : 'neg'}">×${marketIndex(w, sel).toFixed(2)}</b> <span class="muted">（毎月ゆっくり上下します。下の係数に入っています）</span></p>
        <h4>買い取ってくれる所 <small class="muted">係数が高いほど高く買う</small></h4>
        ${sel === 'specialty' ? '<p class="muted small">名産品は町（1,000人〜）と都市が買います。大きな町ほど高く、<b>生まれた町では売れません</b>。</p>' : ''}
        <ul class="list market">${rows
          .map(
            (r) => `<li class="clickable" data-action="goto" data-tile="${r.tile}">
              <span class="mname">${esc(r.name)}${served.has(`${r.kind}:${r.id}`) ? '<span class="served" title="自分の駅で届けられます">駅あり</span>' : ''}${boomed.has(`${r.kind}:${r.id}`) ? '<span class="boom-tag">ブーム</span>' : ''}</span>
              <span class="grow"></span>${gauge(r.stock, r.cap, r.stock > r.cap * 0.8 ? 'bad' : '')}
              <b class="num ${r.demand >= 1 ? 'pos' : 'neg'}">×${r.demand.toFixed(2)}</b></li>`,
          )
          .join('')}</ul>
        <h4>つくっている所</h4>
        <p class="small">${producers.map((i) => `<button class="link" data-action="goto" data-tile="${i.y * w.w + i.x}">${esc(i.name)}</button>`).join('・') || 'なし'}</p>
        <p class="muted small">ゲージは在庫です。同じ所にばかり運ぶと在庫がたまって安くなるので、ほかの届け先に振り分けると得です。ブームの所は期間限定で高く買います。</p>`;
    },
    onAction: (a, el) => {
      if (a === 'cargo') g.marketCargo = el.dataset.c as Cargo;
      if (a === 'goto') {
        const t = Number(el.dataset.tile);
        if (t >= 0) g.renderer.centerOnTile(tx(g.world, t), ty(g.world, t));
      }
      g.wm.refresh('market', true);
    },
  });
}

/** いま起きているブームの一覧（相場表の上） */
function boomList(g: Game): string {
  const list = activeBooms(g.world);
  if (!list.length) return '<p class="muted small">いまはブームはありません。起きるとお知らせが出ます。</p>';
  return `<h4>いまのブーム</h4><ul class="list booms">${list
    .map(
      (b) => `<li class="clickable" data-action="goto" data-tile="${boomTile(g.world, b)}"><span class="boom-tag">${BOOM_LABEL[b.kind]}</span><b>${esc(boomPlace(g.world, b))}</b><span class="small"><span class="cargo-dot ${b.cargo}"></span>${CARGO_SPECS[b.cargo].name} ×${b.mul.toFixed(1)}</span><span class="grow"></span><span class="small muted">あと${Math.max(0, b.until - g.world.day)}日</span></li>`,
    )
    .join('')}</ul>`;
}

// ───────────────────────── 産業をつくる ─────────────────────────

/** 探鉱（一次産業）と工場の建設（二次産業）の種類を選ぶ */
const SURVEY_HINT: Partial<Record<string, string>> = {
  forest: '木の多い所が有利',
  farm: '開けた平野が有利（岩場は不利）',
  ironmine: '山地（岩場）・同じ鉱山が遠い所が有利',
  coalmine: '山地（岩場）・同じ鉱山が遠い所が有利',
  ranch: '山すそ（岩場の近く）が有利',
  fishery: '広い水辺（海）のそばだけ',
};

export function openBuildIndustry(g: Game) {
  g.wm.open({
    id: 'build-industry',
    title: '産業をつくる',
    width: 380,
    render: () => {
      const w = g.world;
      const item = (t: IndustryType, cost: number, note: string) => {
        const spec = INDUSTRY_SPECS[t];
        const name = spec.suffix.replace(/^の/, '');
        const on = g.tool === 'industry' && g.industryType === t;
        return `<button class="buy ${on ? 'on' : ''}" data-action="pick" data-t="${t}" ${cost > w.money ? 'disabled' : ''}>
          <span class="buy-name"><span class="cargo-dot ${spec.output}"></span>${name}</span>
          <span class="num">${formatYen(cost)}</span>
          <span class="muted small">${note}</span></button>`;
      };
      const surveys = w.surveys
        .map((s) => `<li><span>${INDUSTRY_SPECS[s.type].suffix.replace(/^の/, '')}の調査中</span><span class="grow"></span><span class="muted small">あと${Math.max(0, s.doneDay - w.day)}日</span></li>`)
        .join('');
      return `
        <h4>探鉱・開発 <small class="muted">一次産業。成功すると自社の産業になります</small></h4>
        <div class="buy-grid">${PRIMARY_TYPES.map((t) => item(t, INDUSTRY_ECON.surveyCost[t], `${CARGO_SPECS[INDUSTRY_SPECS[t].output].name}・${SURVEY_HINT[t] ?? ''}`)).join('')}</div>
        <p class="muted small">${INDUSTRY_ECON.surveyDays}日の調査のあと、成功か失敗かがわかります。失敗すると費用はもどりません。成功率は場所を選ぶと表示されます。</p>
        ${surveys ? `<ul class="list">${surveys}</ul>` : ''}
        <h4>工場を建てる <small class="muted">${INDUSTRY_ECON.buildDays}日で完成・自社の工場</small></h4>
        <div class="buy-grid">${FACTORY_TYPES.map((t) => item(t, INDUSTRY_ECON.factoryPrice[t], `${INDUSTRY_SPECS[t].inputs.map((c) => CARGO_SPECS[c].name).join('＋')}→${CARGO_SPECS[INDUSTRY_SPECS[t].output].name}`)).join('')}</div>
        <p class="muted small">自社の産業は、運び出した製品の量に応じて毎月利益が入ります（維持費がかかります）。</p>`;
    },
    onAction: (a, el) => {
      if (a === 'pick') {
        g.startIndustryTool(el.dataset.t as IndustryType);
        if (g.touchUI) g.wm.close('build-industry');
      }
      g.wm.refresh('build-industry', true);
    },
  });
}
