import '@fontsource/dotgothic16/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import './style.css';
import { Game } from './game';
import { Renderer } from './render/renderer';
import * as cmds from './sim/commands';
import { formatYen } from './sim/commands';
import * as panels from './ui/panels';
import * as events from './sim/events';
import * as sim from './sim/simulate';
import type { World } from './sim/world';
import { VERSION } from './version';
import { listSaves, loadFrom, metaLabel, pickSaveFile, requestPersistence } from './storage';

async function main() {
  const renderer = await Renderer.create(document.getElementById('stage')!, document.getElementById('labels')!);
  const game = new Game(renderer);
  const title = document.getElementById('title')!;
  const actions = document.getElementById('title-actions')!;
  const params = new URLSearchParams(location.search);
  const seedParam = Number(params.get('seed'));
  const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e9);
  requestPersistence();
  document.getElementById('title-version')!.textContent = `試作版 v${VERSION}`;

  const leaveTitle = async () => {
    // 文字が揃ってから表示する（フォントの読み込み待ち。遅くても1.5秒で進む）
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    title.classList.add('hide');
    setTimeout(() => title.remove(), 500);
  };
  let busy = false;
  const startNew = async () => {
    if (busy) return;
    busy = true;
    await leaveTitle();
    game.newGame(seed);
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
  if (auto && !params.has('seed')) {
    actions.innerHTML = `
      <button id="continue-btn" class="start-btn">続きから</button>
      <p class="continue-meta">${metaLabel(auto)}・${formatYen(auto.money)}・人口 ${auto.population.toLocaleString('ja-JP')}人</p>
      <div class="title-sub">
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
      if (confirm('新しいゲームをはじめますか？\n今の街（オートセーブ）は、次のオートセーブで上書きされます。残したいときは、先に「続きから」でスロットにセーブしてください。')) startNew();
    });
  } else {
    actions.innerHTML = `
      <button id="start-btn" class="start-btn">はじめる</button>
      <div class="title-sub"><button id="file-btn" class="sub-btn">ファイルから読み込む</button></div>`;
    document.getElementById('start-btn')!.addEventListener('click', startNew);
  }
  document.getElementById('file-btn')!.addEventListener('click', async () => {
    try {
      const w = await pickSaveFile();
      if (w) await startWith(w);
    } catch (e) {
      alert((e as Error).message);
    }
  });
  if (params.has('autostart')) startNew();

  // 自動テスト・デバッグ用の入口。公開版には入れない
  // （開発サーバー、または VITE_TEST_HOOKS=1 でビルドしたときだけ）
  if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === '1') {
    (window as unknown as { __game: Game }).__game = game;
    (window as unknown as { __debug: unknown }).__debug = { game, cmds, panels, sim, events };
  }
}

main();
