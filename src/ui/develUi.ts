// 自社開発の画面（v0.8.2）
// ・開発していないとき：名前・動力・用途・予算・色を選んで「開発をはじめる」
// ・開発中：進み具合とポイント。試験のときは方針（堅実・挑戦・大胆）を選ぶ
// ・できあがった機関車の一覧（評価・相性・能力・初期不良の改修）

import { DEV_POWER_NAMES, DEV_POWERS, DEV_USE_NAMES, DEV_USES, type DevPower, type DevUse } from '../sim/constants';
import {
  buyMaker,
  hasMaker,
  MAKER,
  makerError,
  cancelDesign,
  chooseTest,
  compatMark,
  currentDesign,
  defaultDesignName,
  DEV,
  DEV_STAT_NAMES,
  DEV_STATS,
  designSpec,
  devPowerOk,
  devStartError,
  fameLabel,
  fixCost,
  fixDefect,
  startDesign,
  testChance,
  type Design,
  type TestChoice,
} from '../sim/devel';
import { formatYen } from '../sim/commands';
import { dateOf, ELECTRIFY_YEAR } from '../sim/world';
import { hasPart, PARTS, research, researchError, techPerMonth } from '../sim/tech';
import { eraLabel, monthlyDemand, orderText, powerEra, runningCount, saleOf, SALES, unitProfit } from '../sim/sales';
import type { Game } from '../game';
import { esc, gauge } from './panels';
import { comboRecord, openZukanAt } from './zukan';

const ui: { name: string; power: DevPower; use: DevUse; budget: number; color: number; named: boolean } = {
  name: '',
  power: 'diesel',
  use: 'commuter',
  budget: 0,
  color: DEV.colors[0],
  named: false,
};

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const stars = (r: number) => '★'.repeat(r) + '☆'.repeat(5 - r);
const allowText = (a: string) => (a === 'pax' ? '客車だけ' : a === 'freight' ? '貨車だけ' : 'なんでも');

function specLine(d: Design): string {
  const s = designSpec(d);
  return `${s.speed}マス/日・${s.maxCars}両まで（${allowText(s.allow)}）・維持費${Math.round(s.runningCostPerYear / 10000)}万円/年${
    s.comfort && s.comfort > 1 ? `・旅客の運賃×${s.comfort.toFixed(2)}` : ''
  }・1両${formatYen(s.cost)}`;
}

function ptsTable(d: Design): string {
  const max = Math.max(60, ...DEV_STATS.map((k) => d.pts[k]));
  return `<dl class="dev-pts">${DEV_STATS.map(
    (k) => `<dt>${DEV_STAT_NAMES[k]}</dt><dd>${gauge(d.pts[k], max)}<span class="num">${Math.round(d.pts[k])}</span></dd>`,
  ).join('')}</dl>`;
}

function current(g: Game, d: Design): string {
  const ti = d.tests.length;
  const pct = Math.round((d.progress / d.days) * 100);
  let test = '';
  if (d.waiting) {
    const stats = DEV.testStats[ti].map((k) => DEV_STAT_NAMES[k]).join('と');
    const btn = (c: TestChoice, fail: string) => {
      const ch = DEV.choices[c];
      return `<button class="buy dev-choice" data-action="test" data-c="${c}">
        <span class="buy-name"><b>${ch.name}</b></span>
        <span class="num">成功率 ${Math.round(testChance(g.world, c) * 100)}%</span>
        <span class="muted small">成功：${stats}が${ch.bonus >= 0.4 ? '大きく' : ch.bonus >= 0.2 ? 'かなり' : '少し'}伸びる・失敗：${fail}</span></button>`;
    };
    test = `<div class="dev-test">
      <h4>${DEV.testNames[ti]}の方針を選んでください</h4>
      <p class="small">選ぶまで開発は止まっています。</p>
      <div class="buy-grid">
        ${btn('safe', '何も起きない')}
        ${btn('bold', 'ポイントが少し減る')}
        ${btn('daring', '初期不良をかかえる')}
      </div></div>`;
  }
  const results = d.tests
    .map((r, i) => `<li>${DEV.testNames[i]}：${DEV.choices[r.choice].name}で${r.ok ? '<b class="pos">成功</b>' : '<b class="neg">失敗</b>'}</li>`)
    .join('');
  return `
    <h4>開発中：${esc(d.name)} <small class="muted">${DEV_POWER_NAMES[d.power]}・${DEV_USE_NAMES[d.use]}・${DEV.budgets[d.budget].name}</small></h4>
    <div class="dev-progress">${gauge(d.progress, d.days)}<span class="num">${pct}%（あと${d.days - d.progress}日）</span></div>
    ${test}
    ${ptsTable(d)}
    ${results ? `<ul class="dev-results small">${results}</ul>` : ''}
    ${d.defect ? '<p class="small neg">初期不良をかかえています（完成後に改修できます）</p>' : ''}
    <div class="btnrow"><button class="small-btn" data-action="cancel">開発をやめる（開発費は戻りません）</button></div>`;
}

function form(g: Game): string {
  const w = g.world;
  if (!ui.named) ui.name = defaultDesignName(w, ui.power);
  const combos = comboRecord();
  const powerBtns = DEV_POWERS.map((p) => {
    const ok = devPowerOk(w, p);
    return `<button class="seg-btn ${ui.power === p ? 'on' : ''}" data-action="power" data-v="${p}" ${ok ? '' : `disabled title="${ELECTRIFY_YEAR}年から"`}>${DEV_POWER_NAMES[p]}${ok ? '' : `<small>${ELECTRIFY_YEAR}〜</small>`}</button>`;
  }).join('');
  const useBtns = DEV_USES.map((u) => {
    const mark = combos[`${ui.power}:${u}`];
    return `<button class="seg-btn ${ui.use === u ? 'on' : ''}" data-action="use" data-v="${u}">${DEV_USE_NAMES[u]}${mark ? `<small>${mark}</small>` : ''}</button>`;
  }).join('');
  const budgets = DEV.budgets
    .map(
      (b, i) => `<button class="buy ${ui.budget === i ? 'on' : ''}" data-action="budget" data-v="${i}">
      <span class="buy-name"><b>${b.name}</b></span><span class="num">${formatYen(b.cost)}</span>
      <span class="muted small">${b.days}日・${i === 0 ? '手ごろ' : i === 1 ? 'しっかり' : 'とても強い機関車に'}</span></button>`,
    )
    .join('');
  const colors = DEV.colors
    .map(
      (c) =>
        `<button class="dev-color ${ui.color === c ? 'on' : ''}" data-action="color" data-v="${c}" style="background:${hex(c)}" aria-label="色"></button>`,
    )
    .join('');
  const err = devStartError(w, { name: ui.name, power: ui.power, use: ui.use, budget: ui.budget });
  const known = combos[`${ui.power}:${ui.use}`];
  return `
    <h4>新しい機関車を開発する</h4>
    <label class="dev-name">名前 <input type="text" data-key="dev-name" maxlength="16" value="${esc(ui.name)}"></label>
    <div class="dev-row"><span>動力</span><div class="seg">${powerBtns}</div></div>
    <div class="dev-row"><span>用途</span><div class="seg">${useBtns}</div></div>
    <p class="small muted">${
      known
        ? `この組み合わせの相性：<b>${known}</b>`
        : '相性はつくってみるまでわかりません（わかった相性は図鑑の相性表に残ります）'
    }。${ui.use === 'freight' ? '貨物用は貨車だけ' : ui.use === 'mountain' ? '山岳用はなんでも引ける' : '客車だけを引きます'}。${
      ui.power === 'electric' ? '電気は電化した線路だけを走ります。' : ''
    }</p>
    <div class="dev-row"><span>予算</span></div>
    <div class="buy-grid">${budgets}</div>
    <div class="dev-row"><span>色</span><div class="dev-colors">${colors}</div></div>
    <div class="btnrow"><button class="primary" data-action="start" ${err ? 'disabled' : ''}>開発をはじめる（${formatYen(DEV.budgets[ui.budget].cost)}）</button></div>
    ${err ? `<p class="small muted">${esc(err)}</p>` : ''}`;
}

/** 販売：値段・止める・売れたようす */
function saleBlock(g: Game, d: Design): string {
  const w = g.world;
  const s = saleOf(d);
  const left = Math.max(0, SALES.years - (w.day - d.done!) / 365);
  if (s.ended) return `<div class="small muted">販売は終わりました（${s.sold}両・利益${formatYen(s.profit)}）</div>`;
  const prices = SALES.markupNames
    .map((n, i) => `<button class="seg-btn ${s.markup === i ? 'on' : ''}" data-action="markup" data-id="${d.id}" data-v="${i}">${n}</button>`)
    .join('');
  const demand = monthlyDemand(w, d);
  const run = runningCount(w, d);
  return `<div class="dev-sale">
    <div class="dev-row"><span>販売</span>
      <button class="seg-btn ${s.on ? 'on' : ''}" data-action="sale" data-id="${d.id}">${s.on ? '売っています' : '止めています'}</button>
      <small class="muted">あと${left.toFixed(1)}年</small></div>
    <div class="dev-row"><span>値段</span><div class="seg">${prices}</div></div>
    <div class="small">1両の利益 ${formatYen(unitProfit(w, d))}・注文のめやす 月${demand.toFixed(1)}両・先月 ${s.lastMonth}両</div>
    <div class="small">これまで <b>${s.sold}両</b>・利益 <b>${formatYen(s.profit)}</b>${run ? `・自社で${run}本走らせて宣伝中` : '・<span class="muted">自社の路線で走らせると宣伝になります</span>'}</div>
  </div>`;
}

/** 技術点と部品の研究 */
function techBlock(g: Game): string {
  const w = g.world;
  const y = dateOf(w.day).y;
  const rows = PARTS.filter((p) => !p.year || p.year - y <= 6)
    .map((p) => {
      const have = hasPart(w, p.id);
      const err = have ? null : researchError(w, p.id);
      const locked = !!p.year && y < p.year;
      return `<li class="dev-part ${have ? 'have' : ''}">
        <div><b>${have ? '✓ ' : ''}${esc(p.name)}</b> <small class="muted">${p.power ? DEV_POWER_NAMES[p.power] + 'だけ・' : ''}${esc(p.desc)}</small></div>
        ${
          have
            ? ''
            : `<button class="small-btn" data-action="research" data-id="${p.id}" ${err ? `disabled title="${esc(err)}"` : ''}>${
                locked ? `${p.year}年から` : `研究 技術点${p.tech}・${formatYen(p.money)}`
              }</button>`
        }</li>`;
    })
    .join('');
  return `<h4>技術と部品 <button class="link small" data-action="zk-parts">図鑑で見る（説明文）</button></h4>
    <p class="small">技術点 <b>${Math.floor(w.tech ?? 0)}</b> <small class="muted">（運行で毎月 +${techPerMonth(w).toFixed(1)}。自社開発の機関車の列車は2倍。完成でも増えます）</small></p>
    <p class="small muted">部品を研究すると、それからの開発がずっと強くなります。</p>
    <ul class="dev-parts">${rows}</ul>`;
}

function market(g: Game): string {
  const w = g.world;
  const y = dateOf(w.day).y;
  const era = DEV_POWERS.map((p) => `${DEV_POWER_NAMES[p]}：<b>${devPowerOk(w, p) ? eraLabel(powerEra(p, y)) : `${ELECTRIFY_YEAR}年から`}</b>`).join('・');
  const trend = w.devTrend && w.devTrend.year === y ? `今年の流行：<b>${DEV_USE_NAMES[w.devTrend.use]}用</b>` : '今年の流行：（1月に決まります）';
  const orders = (w.devOrders ?? [])
    .map((o) => {
      const days = o.deadline - w.day;
      return `<li><b>${esc(o.from)}</b>：${orderText(o)} <small class="muted">（あと${Math.ceil(days / 30)}か月）</small></li>`;
    })
    .join('');
  const awards = (w.awards ?? [])
    .slice(-4)
    .reverse()
    .map((a) => `<li>${a.year}年：${a.mine ? `<b class="pos">わが社の${esc(a.name)}</b>` : `${esc(a.maker)}の${esc(a.name)}`}</li>`)
    .join('');
  return `<h4>鉄道車両の市場</h4>
    <p class="small">${trend}<br>動力の人気：${era}</p>
    <p class="small"><b>他社からの注文</b>（かなう機関車を完成させると、まとめて売れます）</p>
    <ul class="dev-results small">${orders || '<li class="muted">いまはありません（毎年1月に来ることがあります）</li>'}</ul>
    ${awards ? `<p class="small"><b>鉄道車両大賞</b>（毎年1月。前の年に完成した機関車から）</p><ul class="dev-results small">${awards}</ul>` : ''}`;
}

function doneList(g: Game): string {
  const list = (g.world.designs ?? []).filter((d) => d.done !== undefined);
  if (!list.length) return '';
  return `<h4>自社開発の機関車 <button class="link small" data-action="zk-designs">図鑑で見る（説明文）</button></h4><ul class="dev-list">${list
    .slice()
    .reverse()
    .map(
      (d) => `<li>
        <div><span class="car-dot" style="background:${hex(d.color)}"></span><b>${esc(d.name)}</b>
          <span class="dev-stars">${stars(d.rating ?? 1)}</span>${d.award ? `<span class="zk-badge used">${d.award}年 大賞</span>` : ''}
          <small class="muted">${DEV_POWER_NAMES[d.power]}・${DEV_USE_NAMES[d.use]}・相性${compatMark(d.power, d.use)}</small></div>
        <div class="small">${specLine(d)}</div>
        ${
          d.defect
            ? `<div class="small"><span class="neg">初期不良（維持費が高い）</span> <button class="small-btn" data-action="fix" data-id="${d.id}">改修 ${formatYen(fixCost(d))}</button></div>`
            : ''
        }
        ${saleBlock(g, d)}</li>`,
    )
    .join('')}</ul>`;
}

/** 車両部門を買い取る前 */
function makerPanel(g: Game): string {
  const w = g.world;
  const err = makerError(w);
  const early = dateOf(w.day).y < MAKER.year;
  return `
    <p class="small">わが社は、ツナグ社から<b>鉄道部門</b>を買い取ってできた会社です。車両をつくっているのは、いまもツナグ社です。</p>
    <p class="small">${
      early
        ? `ツナグ社は蒸気機関車にこだわり続けています。<b>${MAKER.year}年ごろ</b>、ツナグ社の車両部門が売りに出されるかもしれません。`
        : 'ツナグ社が<b>車両部門</b>を売りに出しています。買い取ると、自社で機関車を開発して、走らせたり、ほかの鉄道会社に売ったりできます。'
    }</p>
    <ul class="dev-results small">
      <li>自社開発：動力・用途・予算を選んで、オリジナルの機関車をつくる</li>
      <li>販売：完成した機関車を、ほかの鉄道会社に売る</li>
      <li>部品の研究：運行でたまる技術点で、開発を強くする（技術点はいまもたまっています：<b>${Math.floor(w.tech ?? 0)}</b>）</li>
    </ul>
    <div class="btnrow"><button class="primary" data-action="buy-maker" ${err ? 'disabled' : ''}>${
      early ? `${MAKER.year}年ごろ売りに出されます` : `車両部門を買い取る（${formatYen(MAKER.price)}）`
    }</button></div>
    ${err && !early ? `<p class="small muted">${esc(err)}</p>` : ''}
    <p class="small muted">買い取ると、ツナグ社の技術者たちがやってきます（技術点＋${MAKER.tech}）。</p>`;
}

export function openDevel(g: Game) {
  g.wm.open({
    id: 'devel',
    title: '自社開発',
    width: 420,
    render: () => {
      const w = g.world;
      if (!hasMaker(w)) return makerPanel(g);
      const fame = Math.round(w.devFame ?? 0);
      const d = currentDesign(w);
      return `
        <p class="dev-fame">鉄道ファンの評判 <b>${fame}</b> <small class="muted">（${fameLabel(fame)}）</small></p>
        ${d ? current(g, d) : form(g)}
        ${doneList(g)}
        ${techBlock(g)}
        ${market(g)}`;
    },
    onChange: (el) => {
      if (el.dataset.key === 'dev-name') {
        ui.name = el.value.slice(0, 16);
        ui.named = ui.name.trim() !== '';
      }
    },
    onAction: (a, el) => {
      const w = g.world;
      const v = el.dataset.v ?? '';
      if (a === 'power') {
        ui.power = v as DevPower;
        if (!ui.named) ui.name = defaultDesignName(w, ui.power);
      } else if (a === 'use') ui.use = v as DevUse;
      else if (a === 'budget') ui.budget = Number(v);
      else if (a === 'color') ui.color = Number(v);
      else if (a === 'start') {
        // 入力中の名前も拾う（決定前にボタンを押したとき）
        const input = el.closest('.win-body')?.querySelector('[data-key="dev-name"]') as HTMLInputElement | null;
        if (input && input.value.trim()) ui.name = input.value.slice(0, 16);
        const r = startDesign(w, { name: ui.name, power: ui.power, use: ui.use, budget: ui.budget, color: ui.color });
        if (typeof r === 'string') g.toast(r, 'bad');
        else {
          g.toast(`${r.name}の開発をはじめました`, 'good');
          ui.named = false;
          ui.color = DEV.colors[(w.designs?.length ?? 0) % DEV.colors.length];
        }
        g.updateHud();
      } else if (a === 'test') {
        const d = currentDesign(w);
        if (d) {
          const r = chooseTest(w, d.id, el.dataset.c as TestChoice);
          if (r) g.toast(r.ok ? '成功しました！' : '失敗しました…', r.ok ? 'good' : 'bad');
        }
      } else if (a === 'cancel') {
        const d = currentDesign(w);
        if (d && confirm(`${d.name}の開発をやめますか？（開発費は戻りません）`)) cancelDesign(w, d.id);
      } else if (a === 'sale' || a === 'markup') {
        const d = w.designs?.find((x) => x.id === Number(el.dataset.id));
        if (d) {
          const s = saleOf(d);
          if (a === 'sale') s.on = !s.on;
          else s.markup = Number(v);
        }
      } else if (a === 'zk-designs' || a === 'zk-parts') {
        openZukanAt(g, a === 'zk-designs' ? 'designs' : 'parts');
        return;
      } else if (a === 'buy-maker') {
        const err = buyMaker(w);
        if (err) g.toast(err, 'bad');
        else g.toast('ツナグ社の車両部門を買い取りました', 'good');
        g.updateHud();
      } else if (a === 'research') {
        const err = research(w, el.dataset.id ?? '');
        if (err) g.toast(err, 'bad');
        else g.toast('研究が終わりました', 'good');
        g.updateHud();
      } else if (a === 'fix') {
        const err = fixDefect(w, Number(el.dataset.id));
        if (err) g.toast(err, 'bad');
        else g.toast('改修しました', 'good');
        g.updateHud();
      }
      g.wm.refresh('devel', true);
    },
  });
}
