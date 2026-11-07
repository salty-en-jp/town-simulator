// 各ウィンドウの中身（HTML）とボタンの動作

import {
  addOrder,
  borrow,
  buyTrain,
  deleteOrder,
  formatYen,
  repay,
  sellTrain,
  sendToDepot,
  setOrderLoad,
  setOrderUnload,
  skipOrder,
  startStop,
  trainCost,
  trainValue,
} from '../sim/commands';
import { CARGO_SPECS, CARGOS, ENGINE, FINANCE, INDUSTRY, MAX_WAGONS, WAGON_SPECS, type WagonType } from '../sim/constants';
import { demandFactor } from '../sim/economy';
import { acceptance, stationAccepts } from '../sim/simulate';
import {
  carCapacity,
  carCargo,
  carLoad,
  FINANCE_CATEGORIES,
  stationSign,
  tx,
  ty,
  type FinanceCategory,
  type LoadMode,
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
      const cars = t.cars
        .map((c) => {
          if (c.type === 'engine') return `<li><span class="car-dot engine"></span>${ENGINE.name}</li>`;
          const cargo = carCargo(c)!;
          const cap = carCapacity(c, cargo);
          return `<li><span class="car-dot ${c.type}"></span>${WAGON_SPECS[c.type].name}<span class="grow"></span>${gauge(carLoad(c), cap)}<span class="num">${n0(carLoad(c))}/${cap}${CARGO_SPECS[cargo].unit}</span></li>`;
        })
        .join('');
      return `
        <button class="status-bar ${s.tone}" data-action="startstop">${esc(s.text)}</button>
        <div class="btnrow">
          <button data-action="orders">${ICONS.orders}<span>指令</span></button>
          <button data-action="depot">${ICONS.depot}<span>${t.heading === 'depot' && t.state !== 'in_depot' ? '取りやめ' : '車庫へ送る'}</span></button>
          <button data-action="center">${ICONS.center}<span>表示</span></button>
        </div>
        <ul class="cars">${cars}</ul>
        <dl class="stats">
          <dt>今年の利益</dt><dd class="${t.profitThisYear >= 0 ? 'pos' : 'neg'}">${formatYen(t.profitThisYear)}</dd>
          <dt>去年の利益</dt><dd>${formatYen(t.profitLastYear)}</dd>
          <dt>維持費</dt><dd>${formatYen(ENGINE.runningCostPerYear)}/年</dd>
        </dl>
        ${t.state === 'in_depot' ? `<button class="danger wide" data-action="sell">売却する（${formatYen(trainValue(t))}）</button>` : ''}`;
    },
    onAction: (a) => {
      const t = g.world.trains.get(id);
      if (!t) return;
      if (a === 'startstop') g.result(startStop(g.world, id));
      else if (a === 'orders') openOrders(g, id);
      else if (a === 'depot') g.result(sendToDepot(g.world, id));
      else if (a === 'center') g.centerOnTrain(id);
      else if (a === 'sell') {
        g.result(sellTrain(g.world, id));
        g.wm.close(`train-${id}`);
        g.wm.close(`orders-${id}`);
      }
      g.wm.refreshAll();
    },
    onClose: () => {
      if (g.selectedTrain === id) g.selectTrain(-1);
    },
  });
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
          const extra = [o.load !== 'if_available' ? LOAD_LABELS[o.load] : '', o.unload === 'none' ? '降ろさない' : '']
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
        <div class="btnrow">
          <button class="${picking ? 'on' : ''}" data-action="goto" title="地図の駅をクリック（Ctrl+クリックで満載待ち）">${ICONS.station}<span>行き先</span></button>
          <button data-action="delete" ${o ? '' : 'disabled'}>${ICONS.remove}<span>削除</span></button>
          <button data-action="skip" ${ol.orders.length ? '' : 'disabled'}>${ICONS.skip}<span>スキップ</span></button>
        </div>
        ${picking ? `<p class="hint">${g.touchUI ? '地図の駅をタップしてください' : '地図の駅をクリック（Ctrl+クリックで「満載まで待つ」）。Esc で終了'}</p>` : ''}`;
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
      g.wm.refreshAll();
    },
    onClose: () => {
      if (g.tool === 'order' && g.orderTrain === id) g.setTool('none');
    },
  });
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

// ───────────────────────── 車庫 ─────────────────────────

export function openDepot(g: Game, id: number) {
  if (!g.buildComp.has(id)) g.buildComp.set(id, ['logcar', 'logcar']);
  g.wm.open({
    id: `depot-${id}`,
    title: '車庫',
    width: 340,
    render: () => {
      const w = g.world;
      if (!w.depots.has(id)) return '<p class="muted">この車庫はもうありません</p>';
      const inside = [...w.trains.values()].filter((t) => t.depotId === id && t.state === 'in_depot');
      const comp = g.buildComp.get(id)!;
      const compHtml = [`<span class="chip engine">機関車</span>`]
        .concat(comp.map((c, i) => `<button class="chip ${c}" data-action="rm" data-i="${i}" title="外す">${WAGON_SPECS[c].name}<b>×</b></button>`))
        .join('');
      const cloning = g.tool === 'clone' && g.cloneDepot === id;
      return `
        <h4>車庫の中の列車</h4>
        <ul class="list">${
          inside
            .map(
              (t) =>
                `<li><button class="link" data-action="train" data-id="${t.id}">${esc(t.name)}</button><span class="muted small">${t.cars.length - 1}両</span><span class="grow"></span><button class="small-btn" data-action="start" data-id="${t.id}">${ICONS.play}発車</button></li>`,
            )
            .join('') || '<li class="muted">なし</li>'
        }</ul>
        <h4>新しい列車を買う</h4>
        <div class="comp">${compHtml}</div>
        <div class="btnrow wrap">
          ${(Object.keys(WAGON_SPECS) as WagonType[])
            .map(
              (k) =>
                `<button data-action="add" data-k="${k}" ${comp.length >= MAX_WAGONS ? 'disabled' : ''}><span class="car-dot ${k}"></span><span>＋${WAGON_SPECS[k].name}</span></button>`,
            )
            .join('')}
        </div>
        <p class="muted small">${comp.map((c) => `${WAGON_SPECS[c].name}：${CARGO_SPECS[WAGON_SPECS[c].cargo].name}${WAGON_SPECS[c].capacity}${CARGO_SPECS[WAGON_SPECS[c].cargo].unit}`).filter((v, i, a) => a.indexOf(v) === i).join(' ／ ')}</p>
        <div class="btnrow">
          <button class="primary" data-action="buy" ${comp.length ? '' : 'disabled'}>${ICONS.train}<span>購入 ${formatYen(trainCost(comp))}</span></button>
          <button class="${cloning ? 'on' : ''}" data-action="clone" title="押してから地図上の列車をクリック（Ctrl+クリックで指令を共有）">${ICONS.clone}<span>クローン</span></button>
        </div>
        ${
          cloning
            ? `<p class="hint">複製したい列車を地図でクリック${g.touchUI ? '（タップ）' : '（Ctrl+クリックで指令を共有）'}</p>
               <label class="check"><input type="checkbox" data-key="share" ${g.cloneShare ? 'checked' : ''}> 指令を共有する</label>`
            : ''
        }`;
    },
    onAction: (a, el) => {
      const comp = g.buildComp.get(id)!;
      if (a === 'add') comp.push(el.dataset.k as WagonType);
      else if (a === 'rm') comp.splice(Number(el.dataset.i), 1);
      else if (a === 'buy') {
        const r = buyTrain(g.world, id, comp);
        g.result(r);
        if (r.ok && r.id) {
          openTrain(g, r.id);
          openOrders(g, r.id);
          g.toast('列車を買いました。「行き先」で駅を選んでから発車させましょう', 'good');
        }
      } else if (a === 'clone') {
        if (g.tool === 'clone') g.setTool('none');
        else g.startClone(id);
      } else if (a === 'train') openTrain(g, Number(el.dataset.id));
      else if (a === 'start') g.result(startStop(g.world, Number(el.dataset.id)));
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
    width: 330,
    render: () => {
      const ind = g.world.industries.get(id);
      if (!ind) return '';
      const cap = INDUSTRY.stockCap;
      const tr = ind.producedLastMonth > 0 ? ind.transportedLastMonth / ind.producedLastMonth : 0;
      if (ind.type === 'forest') {
        return `
          <p class="lead">原木を生産する森です。近くに駅を作って運び出しましょう。</p>
          <dl class="stats">
            <dt>生産量</dt><dd>原木 ${n0(ind.prodRate)}t/月</dd>
            <dt>先月の生産</dt><dd>${n0(ind.producedLastMonth)}t（輸送率 ${pct(tr)}）</dd>
          </dl>
          <div class="stock"><span>出荷待ち</span>${gauge(ind.outStock, cap)}<span class="num">${n0(ind.outStock)}/${cap}t</span></div>
          <p class="muted small">輸送率（運び出された割合）が高いほど、生産量が増えやすくなります。</p>`;
      }
      const df = demandFactor(ind.inStock);
      return `
        <p class="lead">原木を木材に加工します。木材は町に届けると家が建ちます。</p>
        <div class="stock"><span>原木の在庫</span>${gauge(ind.inStock, cap, ind.inStock > cap * 0.8 ? 'bad' : '')}<span class="num">${n0(ind.inStock)}/${cap}t</span></div>
        <p class="small">いまの買取係数：<b class="${df >= 1 ? 'pos' : 'neg'}">×${df.toFixed(2)}</b><span class="muted">（在庫が少ないほど高く買います）</span></p>
        <div class="stock"><span>木材の在庫</span>${gauge(ind.outStock, cap, ind.outStock > cap * 0.95 ? 'bad' : '')}<span class="num">${n0(ind.outStock)}/${cap}t</span></div>
        ${ind.outStock > cap * 0.95 ? '<p class="warn small">木材の置き場がいっぱいで加工が止まっています。木材を運び出してください。</p>' : ''}
        <dl class="stats">
          <dt>加工能力</dt><dd>${n0(ind.prodRate)}t/月</dd>
          <dt>先月の受け入れ</dt><dd>原木 ${n0(ind.receivedLastMonth)}t</dd>
          <dt>先月の加工</dt><dd>木材 ${n0(ind.producedLastMonth)}t（輸送率 ${pct(tr)}）</dd>
        </dl>`;
    },
  });
}

// ───────────────────────── 町 ─────────────────────────

export function openTown(g: Game, id: number) {
  g.wm.open({
    id: `town-${id}`,
    get title() {
      return `${g.world.towns.get(id)?.name ?? ''}町`;
    },
    width: 310,
    render: () => {
      const t = g.world.towns.get(id);
      if (!t) return '';
      return `
        <dl class="stats">
          <dt>人口</dt><dd><b>${n0(t.population)}人</b></dd>
          <dt>建物</dt><dd>${t.houses}軒</dd>
          <dt>使われている駅</dt><dd>${t.activeStations}駅 ${t.activeStations === 0 ? '<span class="muted">（成長がとても遅い）</span>' : '<span class="pos">（成長中）</span>'}</dd>
          <dt>届いた木材（先月）</dt><dd>${n0(t.lumberReceivedLastMonth)}t</dd>
          <dt>建設を待つ木材</dt><dd>${n0(t.lumber)}t</dd>
          <dt>届いた旅客（先月）</dt><dd>${n0(t.paxReceivedLastMonth)}人</dd>
        </dl>
        <p class="muted small">駅が多く使われているほど町は早く育ちます。木材を届けると、新しい家やアパートが建ちます。</p>`;
    },
  });
}

// ───────────────────────── 財務 ─────────────────────────

const FIN_LABELS: Record<FinanceCategory, string> = {
  construction: '建設費',
  vehicles: '車両の購入・売却',
  running: '維持費',
  income: '運賃収入',
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
          return `<li data-action="open" data-id="${ind.id}" class="clickable"><b>${esc(ind.name)}</b><span class="muted small">${ind.type === 'forest' ? '原木' : '原木→木材'}</span><span class="grow"></span><span class="small">輸送率 ${pct(tr)}</span></li>`;
        })
        .join('')}</ul>
       <p class="muted small">産業チェーン：森林 →（原木）→ 製材所 →（木材）→ 町</p>`,
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
          <tr><th><kbd>D</kbd></th><td>解体（どこでも）</td></tr>
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
          <li>線路の隣に<b>車庫</b>を置き、クリックして<b>原木車</b>つきの列車を買う</li>
          <li><b>指令</b>の「行き先」で森の駅（満載まで待つ）→ 製材所の駅 を選び、<b>発車</b></li>
          <li>製材所でできた<b>木材</b>を、木材車で町へ運ぶと<b>家が建つ</b></li>
        </ol>
        <p class="muted small">試作版（フェーズ0）です。信号・橋・トンネル・地形変更・セーブはまだありません。列車どうしはぶつかりません。</p>
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
      if (a === 'help') openHelp(g);
    },
  });
}

/** 受け入れ判定の説明（プレビュー用） */
export function acceptanceSummary(g: Game, stationId: number): string {
  const st = g.world.stations.get(stationId);
  if (!st) return '';
  const a = acceptance(g.world, st);
  return CARGOS.filter((c) => a[c])
    .map((c) => CARGO_SPECS[c].name)
    .join('・');
}
