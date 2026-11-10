// チャレンジモードの画面：タイトルのステージ選び・遊んでいる間の札・結果

import {
  challengeProgress,
  dailyChallenge,
  formatAmount,
  goalText,
  METRICS,
  randomChallenge,
  RULE_TEXT,
  STAGES,
  starsFor,
  type ChallengeDef,
} from '../sim/challenge';
import { challengeRecords, recordChallenge } from '../storage';
import type { Game } from '../game';
import { esc } from './panels';

export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

function rulesHtml(def: ChallengeDef): string {
  return def.rules.length ? `<span class="ch-rules">${def.rules.map((r) => `<i>${RULE_TEXT[r]}</i>`).join('')}</span>` : '';
}

function goalsHtml(def: ChallengeDef): string {
  return `<ol class="ch-goals">${def.goals.map((n, i) => `<li><b>${starText(i + 1)}</b>${esc(goalText(def, n))}</li>`).join('')}</ol>`;
}

/** タイトル画面のチャレンジ一覧 */
export function renderChallengeMenu(
  el: HTMLElement,
  opts: { saved: { title: string } | null; onPick: (def: ChallengeDef) => void; onContinue: () => void; onBack: () => void },
) {
  const rec = challengeRecords();
  const daily = dailyChallenge();
  const total = STAGES.reduce((n, s) => n + (rec[s.id]?.stars ?? 0), 0);
  const stageList = STAGES.map((s, i) => {
    const r = rec[s.id];
    return `<li><button class="ch-stage" data-pick="stage" data-i="${i}">
        <span class="ch-no">${i + 1}</span>
        <span class="ch-name"><b>${esc(s.title)}</b><small>${esc(goalText(s, s.goals[2]))}（${s.years}年）</small></span>
        <span class="ch-stars ${r ? 'got' : ''}">${starText(r?.stars ?? 0)}</span>
      </button></li>`;
  }).join('');
  const dr = rec[daily.id];
  el.innerHTML = `
    <div class="ch-menu">
      ${opts.saved ? `<button class="start-btn ch-continue" data-pick="continue">続きから：${esc(opts.saved.title)}</button>` : ''}
      <div class="ch-row">
        <button class="ch-card" data-pick="daily">
          <span class="ch-tag">今日のステージ</span>
          <b>${esc(daily.title.replace('今日のステージ：', ''))}</b>
          <small>${esc(goalText(daily, daily.goals[2]))}（${daily.years}年）</small>
          ${rulesHtml(daily)}
          <span class="ch-stars ${dr ? 'got' : ''}">${starText(dr?.stars ?? 0)}</span>
        </button>
        <button class="ch-card" data-pick="random">
          <span class="ch-tag">ランダムステージ</span>
          <b>新しいマップとミッション</b>
          <small>何度でも、ちがうステージに挑戦できます</small>
          <span class="ch-stars">${rec.random ? `これまで ${rec.random.plays}回` : ''}</span>
        </button>
      </div>
      <p class="ch-head">ステージ <small>${total} / ${STAGES.length * 3}</small></p>
      <ul class="ch-stages">${stageList}</ul>
      <p class="ch-note">失敗はありません。期限までにどこまでできたかで ★ が決まります。</p>
      <button class="sub-btn" data-pick="back">もどる</button>
    </div>`;
  el.querySelector('.ch-menu')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-pick]') as HTMLElement | null;
    if (!b) return;
    const k = b.dataset.pick;
    if (k === 'back') opts.onBack();
    else if (k === 'continue') opts.onContinue();
    else if (k === 'daily') opts.onPick(daily);
    else if (k === 'random') opts.onPick(randomChallenge());
    else if (k === 'stage') opts.onPick(STAGES[Number(b.dataset.i)]);
  });
}

/** 遊んでいる間の札（「はじめの目標」の場所に出す） */
export function challengeCardHtml(g: Game): string {
  const c = g.world.challenge!;
  const p = challengeProgress(g.world)!;
  const y = Math.floor(p.daysLeft / 365),
    m = Math.floor((p.daysLeft % 365) / 30.4);
  const left = c.done ? '期限になりました' : `のこり ${y ? `${y}年` : ''}${m}か月`;
  const goal = p.next ?? c.goals[2];
  const pct = Math.min(100, (p.value / goal) * 100);
  return `
    <header><button data-g="toggle" class="g-title">${esc(c.title)} <small class="ch-stars got">${starText(p.stars)}</small></button><button data-g="result" class="g-btn" aria-label="ミッション">?</button></header>
    <div class="ch-body">
      <p class="ch-goal">${p.next !== null ? `${starText(p.stars + 1)} ${esc(goalText(c, p.next))}` : '★★★ 達成！ このまま街を育てても、結果を見てもOK'}</p>
      <div class="ch-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="ch-meta"><span>${esc(METRICS[c.metric].label)}：<b>${formatAmount(c.metric, p.value)}</b></span><span>${left}</span></p>
      ${rulesHtml(c)}
    </div>`;
}

/** ミッションの説明と結果のウィンドウ */
export function openChallengeWindow(g: Game, ended = false) {
  const c = g.world.challenge;
  if (!c) return;
  const p = challengeProgress(g.world)!;
  let isBest = false;
  if (ended) isBest = recordChallenge(c.id, p.stars, p.value);
  const rec = challengeRecords()[c.id];
  g.wm.open({
    id: 'challenge',
    title: ended ? '結果' : 'ミッション',
    width: 380,
    render: () => {
      const now = challengeProgress(g.world)!;
      return `
        <div class="ch-result">
          <p class="ch-title">${esc(c.title)}</p>
          <p class="lead">${esc(c.lead)}</p>
          ${ended || c.done ? `<p class="ch-big">${starText(now.stars)}</p><p class="ch-msg">${['あと少し！ もう一度どうぞ', 'よくできました', 'すばらしい！', 'かんぺき！'][now.stars]}${isBest ? '<br><b>最高記録です！</b>' : ''}</p>` : ''}
          <p class="small">${esc(METRICS[c.metric].label)}：<b>${formatAmount(c.metric, now.value)}</b>${rec ? `（これまでの最高 ${starText(rec.stars)} ${formatAmount(c.metric, rec.best)}）` : ''}</p>
          ${goalsHtml(c)}
          <p class="muted small">期限：${c.years}年${c.rules.length ? `・しばり：${c.rules.map((r) => RULE_TEXT[r]).join('・')}` : ''}。失敗はありません。</p>
          <div class="btnrow wrap">
            ${ended || c.done ? '<button data-action="keep"><span>このまま続ける</span></button>' : ''}
            <button data-action="retry"><span>はじめからやり直す</span></button>
            ${c.kind === 'random' ? '<button data-action="another"><span>別のランダム</span></button>' : ''}
            ${c.kind === 'stage' && STAGES.findIndex((s) => s.id === c.id) < STAGES.length - 1 ? '<button data-action="next"><span>次のステージ</span></button>' : ''}
            <button data-action="title"><span>タイトルへ</span></button>
          </div>
        </div>`;
    },
    onAction: (a) => {
      if (a === 'keep') {
        g.wm.close('challenge');
        if (g.paused) g.togglePause();
      } else if (a === 'retry') {
        if (confirm('このステージを、はじめからやり直しますか？')) g.startChallenge(c);
      } else if (a === 'another') g.startChallenge(randomChallenge());
      else if (a === 'next') {
        const i = STAGES.findIndex((s) => s.id === c.id);
        g.startChallenge(STAGES[i + 1]);
      } else if (a === 'title') {
        g.autosave();
        setTimeout(() => location.reload(), 300);
      }
    },
  });
}

/** 新しい★を取ったときのお知らせ用 */
export function starsNow(def: ChallengeDef, value: number) {
  return starsFor(def, value);
}
