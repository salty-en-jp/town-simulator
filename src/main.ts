import '@fontsource/dotgothic16/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import './style.css';
import { Game } from './game';
import { Renderer } from './render/renderer';
import * as cmds from './sim/commands';
import { formatYen } from './sim/commands';
import * as panels from './ui/panels';
import * as devel from './sim/devel';
import * as events from './sim/events';
import * as sim from './sim/simulate';
import type { World } from './sim/world';
import { VERSION } from './version';
import type { ChallengeDef } from './sim/challenge';
import { LANDFORMS, MAP_SIZES, type Landform, type MapSize } from './sim/mapgen';
import { PACES, type Pace } from './sim/world';
import { renderChallengeMenu } from './ui/challengeUi';
import { daysSinceBackup, isSafeStorage, listSaves, loadFrom, metaLabel, pickSaveFile, requestPersistence, storageStatus } from './storage';

const escHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function main() {
  const renderer = await Renderer.create(document.getElementById('stage')!, document.getElementById('labels')!);
  const game = new Game(renderer);
  const title = document.getElementById('title')!;
  const actions = document.getElementById('title-actions')!;
  const params = new URLSearchParams(location.search);
  const seedParam = Number(params.get('seed'));
  const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e9);
  requestPersistence();
  // オフラインでも起動できるように（公開版だけ。開発中はしまっておくと紛らわしいので使わない）
  if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  }
  document.getElementById('title-version')!.textContent = `試作版 v${VERSION}`;

  const leaveTitle = async () => {
    // 文字が揃ってから表示する（フォントの読み込み待ち。遅くても1.5秒で進む）
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    title.classList.add('hide');
    setTimeout(() => title.remove(), 500);
  };
  let busy = false;
  const startNew = async (opts: { size?: number; pace?: Pace; landform?: Landform } = {}) => {
    if (busy) return;
    busy = true;
    await leaveTitle();
    game.newGame(seed, opts);
  };

  // 新しいゲームの設定（マップの広さ・時間の流れ）。前に選んだものを覚えておく
  const loadPrefs = (): { size: MapSize; pace: Pace; landform: Landform } => {
    try {
      const v = JSON.parse(localStorage.getItem('tsunagu.newGame') ?? '{}');
      return { size: v.size in MAP_SIZES ? v.size : 'normal', pace: v.pace in PACES ? v.pace : 'normal', landform: v.landform in LANDFORMS ? v.landform : 'mixed' };
    } catch {
      return { size: 'normal', pace: 'normal', landform: 'mixed' };
    }
  };
  const showNewGame = () => {
    const pref = loadPrefs();
    const opt = (group: string, key: string, name: string, desc: string, on: boolean) =>
      `<button class="ng-opt ${on ? 'on' : ''}" data-ng="${group}" data-k="${key}"><b>${name}</b><small>${desc}</small></button>`;
    const render = () => {
      actions.innerHTML = `
        <div class="ng-menu">
          <p class="ch-head">新しいゲーム</p>
          <p class="ng-label">マップの広さ <small>町の数は広さで決まります</small></p>
          <div class="ng-opts">${(Object.keys(MAP_SIZES) as MapSize[]).map((k) => opt('size', k, MAP_SIZES[k].name, MAP_SIZES[k].desc, pref.size === k)).join('')}</div>
          <p class="ng-label">地形 <small>山地（岩場）は線路が高く、家が建ちません。土地によって多い産業が変わります</small></p>
          <div class="ng-opts four">${(Object.keys(LANDFORMS) as Landform[]).map((k) => opt('landform', k, LANDFORMS[k].name, LANDFORMS[k].desc, pref.landform === k)).join('')}</div>
          <p class="ng-label">時間の流れ <small>列車の速さは同じ。相場・ブーム・町の成長などの速さが変わります（あとから変えられます）</small></p>
          <div class="ng-opts">${(Object.keys(PACES) as Pace[]).map((k) => opt('pace', k, PACES[k].name, PACES[k].desc, pref.pace === k)).join('')}</div>
          <button class="start-btn" data-ng="start">はじめる</button>
          <button class="sub-btn" data-ng="back">もどる</button>
        </div>`;
    };
    render();
    title.classList.add('ch-mode');
    actions.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-ng]') as HTMLElement | null;
      if (!b) return;
      const k = b.dataset.ng;
      if (k === 'size') pref.size = b.dataset.k as MapSize;
      if (k === 'pace') pref.pace = b.dataset.k as Pace;
      if (k === 'landform') pref.landform = b.dataset.k as Landform;
      if (k === 'size' || k === 'pace' || k === 'landform') {
        render();
        return;
      }
      actions.onclick = null;
      if (k === 'back') {
        title.classList.remove('ch-mode');
        renderMain();
        return;
      }
      try {
        localStorage.setItem('tsunagu.newGame', JSON.stringify(pref));
      } catch {
        /* 覚えられなくてもよい */
      }
      void startNew({ size: MAP_SIZES[pref.size].size, pace: pref.pace, landform: pref.landform });
    };
  };
  const startWith = async (w: World) => {
    if (busy) return;
    busy = true;
    await leaveTitle();
    game.startWorld(w);
  };

  // オートセーブがあれば「続きから」を出す
  const saves = await listSaves();
  const auto = saves.auto;
  const challengeSave = saves.challenge;
  const startChallenge = async (def: ChallengeDef) => {
    if (busy) return;
    busy = true;
    await leaveTitle();
    game.startChallenge(def);
  };

  const renderMain = () => {
    const challengeBtn = '<button id="challenge-btn" class="sub-btn ch-open">チャレンジ</button>';
    if (auto && !params.has('seed')) {
      actions.innerHTML = `
        <button id="continue-btn" class="start-btn">続きから</button>
        <p class="continue-meta">${auto.rank ? `${escHtml(auto.rank)}・` : ''}${metaLabel(auto)}・${formatYen(auto.money)}・人口 ${auto.population.toLocaleString('ja-JP')}人</p>
        <div class="title-sub">
          ${challengeBtn}
          <button id="new-btn" class="sub-btn">はじめから</button>
          <button id="file-btn" class="sub-btn">ファイルから読み込む</button>
        </div>`;
      document.getElementById('continue-btn')!.addEventListener('click', async () => {
        try {
          const w = await loadFrom('auto');
          if (w) await startWith(w);
          else await startNew();
        } catch (e) {
          alert((e as Error).message);
        }
      });
      document.getElementById('new-btn')!.addEventListener('click', () => {
        if (confirm('新しいゲームをはじめますか？\n今の街（オートセーブ）は、次のオートセーブで上書きされます。残したいときは、先に「続きから」でスロットにセーブしてください。')) showNewGame();
      });
    } else {
      actions.innerHTML = `
        <button id="start-btn" class="start-btn">はじめる</button>
        <div class="title-sub">${challengeBtn}<button id="file-btn" class="sub-btn">ファイルから読み込む</button></div>`;
      document.getElementById('start-btn')!.addEventListener('click', showNewGame);
    }
    document.getElementById('file-btn')!.addEventListener('click', async () => {
      try {
        const w = await pickSaveFile();
        if (w) await startWith(w);
      } catch (e) {
        alert((e as Error).message);
      }
    });
    document.getElementById('challenge-btn')!.addEventListener('click', () => {
      title.classList.add('ch-mode');
      renderChallengeMenu(actions, {
        saved: challengeSave ? { title: challengeSave.challenge ?? 'チャレンジ' } : null,
        onPick: (def) => void startChallenge(def),
        onContinue: async () => {
          try {
            const w = await loadFrom('challenge');
            if (w) await startWith(w);
          } catch (e) {
            alert((e as Error).message);
          }
        },
        onBack: () => {
          title.classList.remove('ch-mode');
          renderMain();
        },
      });
    });
  };
  renderMain();
  // データの安全の目安（タイトルの下に小さく）
  void storageStatus().then((s) => {
    const note = document.createElement('p');
    note.className = 'title-safety';
    const days = daysSinceBackup();
    const lines: string[] = [];
    if (s.standalone) lines.push('✓ ホーム画面アプリ：データは消えにくい状態です');
    else if (s.ios) lines.push('ホーム画面に追加して遊ぶと、データが消えにくくなります（共有ボタン →「ホーム画面に追加」）');
    else if (isSafeStorage(s)) lines.push('✓ この端末のブラウザに保存しています');
    if (auto) lines.push(days === null ? 'まだ街をファイルに書き出していません（セーブ画面から）' : `最後のバックアップ：${days === 0 ? '今日' : `${days}日前`}`);
    else if (s.standalone && s.ios) lines.push('Safari で遊んでいた街は、Safari で「ファイルに書き出す」→ ここで「ファイルから読み込む」で移せます');
    note.textContent = lines.join('　／　');
    if (lines.length) actions.after(note);
  });
  if (params.has('autostart')) void startNew();
  else if (params.has('new')) showNewGame();

  // 自動テスト・デバッグ用の入口。公開版には入れない
  // （開発サーバー、または VITE_TEST_HOOKS=1 でビルドしたときだけ）
  if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === '1') {
    (window as unknown as { __game: Game }).__game = game;
    (window as unknown as { __debug: unknown }).__debug = { game, cmds, panels, sim, events, devel };
  }
}

main();
