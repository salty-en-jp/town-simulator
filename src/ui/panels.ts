// 各ウィンドウの中身（HTML）とボタンの動作

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
  setOrderDest,
  setOrderLoad,
  setOrderUnload,
  skipOrder,
  startStop,
  trainValue,
} from '../sim/commands';
import {
  CARGO_SPECS,
  CARGOS,
  ENGINE_SPECS,
  ENGINE_TYPES,
  FINANCE,
  INDUSTRY,
  INDUSTRY_SPECS,
  isEngine,
  TOWN,
  TOWN_GOODS,
  vehicleCost,
  vehicleName,
  WAGON_SPECS,
  WAGON_TYPES,
  type Cargo,
  type VehicleType,
} from '../sim/constants';
import { demandFactor } from '../sim/economy';
import { daysLeft, rewardText } from '../sim/requests';
import { acceptorDemand, acceptorName, acceptors, acceptorStock, stationAccepts } from '../sim/simulate';
import {
  canBuy,
  carCapacity,
  carCargo,
  carLoad,
  FINANCE_CATEGORIES,
  stationSign,
  trainEngine,
  tx,
  ty,
  type FinanceCategory,
  type LoadMode,
  type Order,
  type Train,
  type UnloadMode,
} from '../sim/world';
import type { Game } from '../game';
import { ICONS } from './icons';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const n0 = (v: number) => Math.floor(v).toLocaleString('ja-JP');
const pct = (v: number) => `${Math.round(v * 100)}%`;

function gauge(value: number, max: number, cls = '') {
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
      return { text: t.heading === 'depot' ? '車庫へ向かっています' : `${stName}へ向かっています`, tone: 'ok' };
  }
}

export function openTrain(g: Game, id: number) {
  g.selectTrain(id);
  g.wm.open({
    id: `train-${id}`,
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
          if (isEngine(c.type)) return `<li><span class="car-dot ${c.type}"></span>${esc(vehicleName(c.type))}<span class="grow"></span><span class="muted small">${ageText(g, c.built)}</span></li>`;
          const cargo = carCargo(c)!;
          const cap = carCapacity(c, cargo);
          return `<li><span class="car-dot ${c.type}"></span>${esc(vehicleName(c.type))}<span class="grow"></span>${gauge(carLoad(c), cap)}<span class="num">${n0(carLoad(c))}/${cap}${CARGO_SPECS[cargo].unit}</span></li>`;
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
        <ul class="cars">${cars}</ul>
        <dl class="stats">
          <dt>速さ</dt><dd>${eng.speed}マス/日</dd>
          <dt>今年の利益</dt><dd class="${t.profitThisYear >= 0 ? 'pos' : 'neg'}">${formatYen(t.profitThisYear)}</dd>
          <dt>去年の利益</dt><dd>${formatYen(t.profitLastYear)}</dd>
          <dt>維持費（走っているとき）</dt><dd>${formatYen(eng.runningCostPerYear)}/年</dd>
        </dl>
        ${inDepot ? '' : '<p class="muted small">編成を変えるには、いったん車庫へ送ってください。</p>'}`;
    },
    onAction: (a) => {
      const t = g.world.trains.get(id);
      if (!t) return;
      if (a === 'startstop') g.result(startStop(g.world, id));
      else if (a === 'orders') openOrders(g, id);
      else if (a === 'depot') g.result(sendToDepot(g.world, id));
      else if (a === 'center') g.centerOnTrain(id);
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
          ]
            .filter(Boolean)
            .join('・');
          return `<li class="order ${i === sel ? 'sel' : ''} ${i === t.curOrder ? 'cur' : ''}" data-action="sel" data-i="${i}">
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
        <div class="btnrow">
          <button class="${picking ? 'on' : ''}" data-action="goto" title="地図の駅をクリック（Ctrl+クリックで満載待ち）">${ICONS.station}<span>行き先</span></button>
          <button data-action="delete" ${o ? '' : 'disabled'}>${ICONS.remove}<span>削除</span></button>
          <button data-action="skip" ${ol.orders.length ? '' : 'disabled'}>${ICONS.skip}<span>スキップ</span></button>
        </div>
        ${picking ? `<p class="hint">${g.touchUI ? '地図の駅か駅名をタップ。終わったら下のバーの「完了」' : '地図の駅か駅名をクリック（Ctrl+クリックで「満載まで待つ」）。終わったら下のバーの「完了」か Esc'}</p>` : ''}`;
    },
    onAction: (a, el) => {
      const t = g.world.trains.get(id);
      if (!t) return;
      if (a === 'sel') g.orderSel.set(id, Number(el.dataset.i));
      else if (a === 'goto') g.startOrderPick(id);
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
      if (el.dataset.key === 'dest') {
        const [kind, did] = el.value.split(':');
        g.result(setOrderDest(g.world, id, sel, kind === 'auto' ? null : { kind: kind as 'industry' | 'town', id: Number(did) }));
      }
      g.wm.refreshAll();
    },
    onClose: () => {
      if (g.tool === 'order' && g.orderTrain === id) g.setTool('none');
    },
  });
}

/**
 * 届け先の選択欄。列車が運ぶ貨物を、その駅で受け入れる先が2つ以上あるときだけ選べる
 */
function destField(g: Game, t: Train, o: Order): string {
  const w = g.world;
  const st = w.stations.get(o.station);
  if (!st) return '';
  const cargos = [...new Set(t.cars.map((c) => carCargo(c)).filter((c): c is Cargo => !!c))];
  const options = new Map<string, string>();
  for (const c of cargos) {
    for (const a of acceptors(w, st, c)) {
      const key = `${a.kind}:${a.id}`;
      const label = `${acceptorName(w, a)}（${CARGO_SPECS[c].name} ×${acceptorDemand(w, a, c).toFixed(2)}）`;
      options.set(key, options.has(key) ? options.get(key)!.replace('）', `・${CARGO_SPECS[c].name} ×${acceptorDemand(w, a, c).toFixed(2)}）`) : label);
    }
  }
  if (options.size === 0) return '';
  if (options.size === 1) {
    return `<p class="small muted">届け先：${esc([...options.values()][0])}</p>`;
  }
  const cur = o.dest ? `${o.dest.kind}:${o.dest.id}` : 'auto';
  return `<div class="field-row"><label>届け先（この駅で受け入れる先が${options.size}つあります）<select data-key="dest">
      <option value="auto" ${cur === 'auto' ? 'selected' : ''}>自動（いちばん近い所）</option>
      ${[...options].map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select></label></div>`;
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
};

function vehicleDesc(t: VehicleType): string {
  if (isEngine(t)) return `${ENGINE_SPECS[t].speed}マス/日`;
  const w = WAGON_SPECS[t];
  return `${CARGO_SPECS[w.cargo].name}${w.capacity}${CARGO_SPECS[w.cargo].unit}`;
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
                ? `<span class="chip ${c.type}">${SHORT_NAMES[c.type]}</span>`
                : `<button class="chip ${c.type}" data-action="detach" data-train="${t.id}" data-car="${c.id}" title="外して留置線へ">${SHORT_NAMES[c.type]}<b>↓</b></button>`,
            )
            .join('');
          const wagons = t.cars.length - 1;
          return `<li class="dtrain ${t.id === sel ? 'sel' : ''}" data-action="seltrain" data-id="${t.id}">
            <div class="dtrain-head"><b>${esc(t.name)}</b><span class="muted small">貨車${wagons}両</span><span class="grow"></span>
              <button class="small-btn" data-action="start" data-id="${t.id}">${ICONS.play}発車</button></div>
            <div class="consist">${chips}</div></li>`;
        })
        .join('');

      const stored = depot.stored
        .map((c) => {
          const engine = isEngine(c.type);
          const action = engine
            ? `<button class="small-btn" data-action="maketrain" data-car="${c.id}">列車にする</button>`
            : `<button class="small-btn" data-action="attach" data-car="${c.id}" ${selTrain ? '' : 'disabled title="先に上で列車を選んでください"'}>↑つなぐ</button>`;
          return `<li><span class="car-dot ${c.type}"></span><span>${SHORT_NAMES[c.type]}<small class="muted"> ${ageText(g, c.built)}</small></span><span class="grow"></span>${action}<button class="small-btn" data-action="sellcar" data-car="${c.id}" title="売却">売る ${formatYen(carValue(w, c))}</button></li>`;
        })
        .join('');

      const buy = [...ENGINE_TYPES, ...WAGON_TYPES]
        .map((t) => {
          const ok = canBuy(w, t);
          return `<button class="buy ${ok ? '' : 'locked'}" data-action="buy" data-k="${t}" ${ok ? '' : 'disabled'} title="${ok ? '' : '依頼の報酬で解禁されます'}">
            <span class="buy-name"><span class="car-dot ${t}"></span>${SHORT_NAMES[t]}${ok ? '' : ' 🔒'}</span>
            <span class="muted small">${vehicleDesc(t)}</span>
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
        <h4>車両を買う</h4>
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
        <p class="muted small">評価は「列車が来る頻度・待っている量・列車の速さ」で決まります。評価が高いほど多くの貨物が駅に来ます。</p>`;
    },
    onClose: () => {
      if (g.selectedStation === id) g.selectStation(-1);
    },
  });
}

// ───────────────────────── 産業 ─────────────────────────

export function openIndustry(g: Game, id: number) {
  g.wm.open({
    id: `industry-${id}`,
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
      return `
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
        ${spec.inputs.length ? '' : '<p class="muted small">輸送率（運び出された割合）が高いほど、生産量が増えやすくなります。</p>'}`;
    },
  });
}

function cargoTag(c: Cargo): string {
  return `<span class="tag"><span class="cargo-dot ${c}"></span>${CARGO_SPECS[c].name}</span>`;
}

// ───────────────────────── 町 ─────────────────────────

export function openTown(g: Game, id: number) {
  g.wm.open({
    id: `town-${id}`,
    get title() {
      return `${g.world.towns.get(id)?.name ?? ''}町`;
    },
    width: 320,
    render: () => {
      const t = g.world.towns.get(id);
      if (!t) return '';
      const goods = TOWN_GOODS.map((c) => {
        const r = t.recv[c];
        return `<tr><th>${cargoTag(c)}</th><td class="num">${n0(r?.lm ?? 0)}t</td><td class="num">${n0(t.stock[c] ?? 0)}t</td><td class="num">×${demandFactor(t.stock[c] ?? 0, TOWN.stockCap).toFixed(2)}</td></tr>`;
      }).join('');
      return `
        <dl class="stats">
          <dt>人口</dt><dd><b>${n0(t.population)}人</b></dd>
          <dt>建物</dt><dd>${t.houses}軒</dd>
          <dt>使われている駅</dt><dd>${t.activeStations}駅 ${t.activeStations === 0 ? '<span class="muted">（成長がとても遅い）</span>' : '<span class="pos">（成長中）</span>'}</dd>
          <dt>食料品</dt><dd>${t.fed ? '<span class="pos">足りている（早く育つ）</span>' : '<span class="muted">足りない</span>'}</dd>
          <dt>届いた旅客（先月）</dt><dd>${n0(t.recv.passengers?.lm ?? 0)}人</dd>
        </dl>
        <table class="tbl"><tr><th></th><th class="num">先月届いた</th><th class="num">在庫</th><th class="num">買取</th></tr>${goods}</table>
        <p class="muted small">木材で家とアパート、建設資材で高層ビルが建ちます。食料品が足りていると町が早く育ちます。駅がよく使われているほど成長が速くなります。</p>`;
    },
  });
}

// ───────────────────────── 財務 ─────────────────────────

const FIN_LABELS: Record<FinanceCategory, string> = {
  construction: '建設費',
  vehicles: '車両の購入・売却',
  running: '列車の維持費',
  facilities: '車庫代',
  income: '運賃収入',
  rewards: '依頼の報酬',
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
        </div>`;
    },
    onAction: (a) => {
      if (a === 'borrow') g.result(borrow(g.world));
      if (a === 'repay') g.result(repay(g.world));
      g.wm.refreshAll();
    },
  });
}

// ───────────────────────── 一覧 ─────────────────────────

export function openTrainList(g: Game) {
  g.wm.open({
    id: 'trains',
    title: '列車一覧',
    width: 380,
    render: () => {
      const list = [...g.world.trains.values()];
      if (!list.length) return '<p class="muted">列車がありません。車庫をクリックして列車を買いましょう。</p>';
      return `<ul class="list">${list
        .map((t) => {
          const s = trainStatus(g, t);
          return `<li data-action="open" data-id="${t.id}" class="clickable"><b>${esc(t.name)}</b><span class="small ${s.tone === 'bad' ? 'neg' : 'muted'} ellipsis">${esc(s.text.replace(' — クリックで発車', ''))}</span><span class="grow"></span><span class="num ${t.profitThisYear >= 0 ? 'pos' : 'neg'}">${formatYen(t.profitThisYear)}</span></li>`;
        })
        .join('')}</ul>`;
    },
    onAction: (a, el) => {
      if (a === 'open') openTrain(g, Number(el.dataset.id));
    },
  });
}

export function openStationList(g: Game) {
  g.wm.open({
    id: 'stations',
    title: '駅一覧',
    width: 340,
    render: () => {
      const list = [...g.world.stations.values()];
      if (!list.length) return '<p class="muted">駅がありません。鉄道建設ツールの「駅」で作れます。</p>';
      return `<ul class="list">${list
        .map((st) => {
          const waiting = CARGOS.filter((c) => st.goods[c].waiting >= 1)
            .map((c) => `<span class="tag"><span class="cargo-dot ${c}"></span>${n0(st.goods[c].waiting)}${CARGO_SPECS[c].unit}</span>`)
            .join('');
          return `<li data-action="open" data-id="${st.id}" class="clickable"><b>${esc(st.name)}</b><span class="grow"></span>${waiting}</li>`;
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
  });
}

export function openIndustryList(g: Game) {
  g.wm.open({
    id: 'industries',
    title: '産業一覧',
    width: 340,
    render: () =>
      `<ul class="list">${[...g.world.industries.values()]
        .map((ind) => {
          const tr = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0;
          return `<li data-action="open" data-id="${ind.id}" class="clickable"><b>${esc(ind.name)}</b><span class="muted small">${INDUSTRY_SPECS[ind.type].inputs.map((c) => CARGO_SPECS[c].name).join('＋')}${INDUSTRY_SPECS[ind.type].inputs.length ? '→' : ''}${CARGO_SPECS[INDUSTRY_SPECS[ind.type].output].name}</span><span class="grow"></span><span class="small">輸送率 ${pct(tr)}</span></li>`;
        })
        .join('')}</ul>
       <p class="muted small">森→製材所→木材（町に家）／農場→食品工場→食料品（町が早く育つ）／鉄鉱山＋炭鉱→製鉄所→鋼材／木材＋鋼材→建材工場→建設資材（町に高層ビル）</p>`,
    onAction: (a, el) => {
      if (a === 'open') {
        const ind = g.world.industries.get(Number(el.dataset.id))!;
        g.renderer.centerOnTile(ind.x + 1, ind.y + 1);
        openIndustry(g, ind.id);
      }
    },
  });
}

export function openTownList(g: Game) {
  g.wm.open({
    id: 'towns',
    title: '町一覧',
    width: 300,
    render: () =>
      `<ul class="list">${[...g.world.towns.values()]
        .map(
          (t) =>
            `<li data-action="open" data-id="${t.id}" class="clickable"><b>${esc(t.name)}町</b><span class="grow"></span><span class="num">${n0(t.population)}人</span></li>`,
        )
        .join('')}</ul>`,
    onAction: (a, el) => {
      if (a === 'open') {
        const t = g.world.towns.get(Number(el.dataset.id))!;
        g.renderer.centerOnTile(t.cx, t.cy);
        openTown(g, t.id);
      }
    },
  });
}

// ───────────────────────── ヘルプ・メニュー ─────────────────────────

export function openHelp(g: Game) {
  g.wm.open({
    id: 'help',
    title: '操作方法',
    width: 460,
    render: () => `
      <div class="help">
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
        </table>
        <h4>遊び方</h4>
        <ol class="steps">
          <li>森と製材所の近くに<b>駅</b>を建てて、<b>線路</b>でつなぐ</li>
          <li>線路の隣に<b>車庫</b>を置いてクリックし、<b>機関車</b>を買ってから<b>原木車</b>を買う（列車につながります）</li>
          <li><b>指令</b>の「行き先」で森の駅（満載まで待つ）→ 製材所の駅 を選び、<b>発車</b></li>
          <li>製材所でできた<b>木材</b>を、木材車で町へ運ぶと<b>家が建つ</b></li>
          <li>ほかにも、農場→食品工場→<b>食料品</b>（町が早く育つ）、鉄鉱山と炭鉱→製鉄所→<b>鋼材</b>、木材と鋼材→建材工場→<b>建設資材</b>（高層ビル）。<b>相場表</b>（F10）で、どこが高く買うか見られます</li>
        </ol>
        <p class="muted small">試作版 v0.3 です。信号・橋・トンネル・地形変更はまだありません。列車どうしはぶつかりません。セーブは自動でも行われます。</p>
        <h4>画面</h4>
        <div class="btnrow">
          <button data-action="ui-auto" class="${g.uiPref === 'auto' ? 'on' : ''}"><span>自動</span></button>
          <button data-action="ui-pc" class="${g.uiPref === 'pc' ? 'on' : ''}"><span>PC</span></button>
          <button data-action="ui-touch" class="${g.uiPref === 'touch' ? 'on' : ''}"><span>スマホ</span></button>
        </div>
      </div>`,
    onAction: (a) => {
      if (a === 'ui-auto') g.setUiPref('auto');
      if (a === 'ui-pc') g.setUiPref('pc');
      if (a === 'ui-touch') g.setUiPref('touch');
      g.wm.refresh('help', true);
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
        <button data-action="save">${ICONS.save}<span>セーブ／ロード</span></button>
        <button data-action="towns">${ICONS.depot}<span>町一覧</span></button>
        <button data-action="help">${ICONS.help}<span>操作方法</span></button>
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
      if (a === 'save') g.openSaveLoad();
      if (a === 'help') openHelp(g);
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
          const a = { kind: 'town' as const, id: t.id };
          rows.push({ ...a, name: `${t.name}町`, stock: acceptorStock(w, a, sel), cap: TOWN.stockCap, demand: acceptorDemand(w, a, sel), tile: t.cy * w.w + t.cx });
        }
      }
      rows.sort((p, q) => q.demand - p.demand);
      const producers = [...w.industries.values()].filter((i) => INDUSTRY_SPECS[i.type].output === sel);
      const spec = CARGO_SPECS[sel];
      return `
        <div class="mtabs">${tabs}</div>
        <p class="small">基本運賃 <b>${formatYen(spec.rate * 10)}</b>/t（10マスあたり）・${spec.days1}日までは満額${spec.days1 <= 8 ? '<span class="warn">（傷みやすい）</span>' : ''}</p>
        <h4>買い取ってくれる所 <small class="muted">係数が高いほど高く買う</small></h4>
        <ul class="list market">${rows
          .map(
            (r) => `<li class="clickable" data-action="goto" data-tile="${r.tile}">
              <span class="mname">${esc(r.name)}${served.has(`${r.kind}:${r.id}`) ? '<span class="served" title="自分の駅で届けられます">駅あり</span>' : ''}</span>
              <span class="grow"></span>${gauge(r.stock, r.cap, r.stock > r.cap * 0.8 ? 'bad' : '')}
              <b class="num ${r.demand >= 1 ? 'pos' : 'neg'}">×${r.demand.toFixed(2)}</b></li>`,
          )
          .join('')}</ul>
        <h4>つくっている所</h4>
        <p class="small">${producers.map((i) => `<button class="link" data-action="goto" data-tile="${i.y * w.w + i.x}">${esc(i.name)}</button>`).join('・') || 'なし'}</p>
        <p class="muted small">ゲージは在庫です。同じ所にばかり運ぶと在庫がたまって安くなるので、ほかの届け先に振り分けると得です。</p>`;
    },
    onAction: (a, el) => {
      if (a === 'cargo') g.marketCargo = el.dataset.c as Cargo;
      if (a === 'goto') {
        const t = Number(el.dataset.tile);
        g.renderer.centerOnTile(tx(g.world, t), ty(g.world, t));
      }
      g.wm.refresh('market', true);
    },
  });
}
