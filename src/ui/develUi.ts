// 自社開発の画面（v0.8.2）
// ・開発していないとき：名前・動力・用途・予算・色を選んで「開発をはじめる」
// ・開発中：進み具合とポイント。試験のときは方針（堅実・挑戦・大胆）を選ぶ
// ・できあがった機関車の一覧（評価・相性・能力・初期不良の改修）

import { DEV_POWER_NAMES, DEV_POWERS, DEV_USE_NAMES, DEV_USES, type DevPower, type DevUse } from '../sim/constants';
import {
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
import { ELECTRIFY_YEAR } from '../sim/world';
import type { Game } from '../game';
import { esc, gauge } from './panels';
import { comboRecord } from './zukan';

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

function doneList(g: Game): string {
  const list = (g.world.designs ?? []).filter((d) => d.done !== undefined);
  if (!list.length) return '';
  return `<h4>自社開発の機関車</h4><ul class="dev-list">${list
    .slice()
    .reverse()
    .map(
      (d) => `<li>
        <div><span class="car-dot" style="background:${hex(d.color)}"></span><b>${esc(d.name)}</b>
          <span class="dev-stars">${stars(d.rating ?? 1)}</span>
          <small class="muted">${DEV_POWER_NAMES[d.power]}・${DEV_USE_NAMES[d.use]}・相性${compatMark(d.power, d.use)}</small></div>
        <div class="small">${specLine(d)}</div>
        ${
          d.defect
            ? `<div class="small"><span class="neg">初期不良（維持費が高い）</span> <button class="small-btn" data-action="fix" data-id="${d.id}">改修 ${formatYen(fixCost(d))}</button></div>`
            : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

export function openDevel(g: Game) {
  g.wm.open({
    id: 'devel',
    title: '自社開発',
    width: 420,
    render: () => {
      const w = g.world;
      const fame = Math.round(w.devFame ?? 0);
      const d = currentDesign(w);
      return `
        <p class="dev-fame">鉄道ファンの評判 <b>${fame}</b> <small class="muted">（${fameLabel(fame)}）</small></p>
        ${d ? current(g, d) : form(g)}
        ${doneList(g)}`;
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
