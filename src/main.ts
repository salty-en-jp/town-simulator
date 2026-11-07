import '@fontsource/dotgothic16/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import './style.css';
import { Game } from './game';
import { Renderer } from './render/renderer';

async function main() {
  const renderer = await Renderer.create(document.getElementById('stage')!, document.getElementById('labels')!);
  const game = new Game(renderer);
  const title = document.getElementById('title')!;
  const params = new URLSearchParams(location.search);
  const seedParam = Number(params.get('seed'));
  const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e9);

  const start = async () => {
    // 文字が揃ってから表示する（フォントの読み込み待ち。遅くても1.5秒で進む）
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    title.classList.add('hide');
    setTimeout(() => title.remove(), 500);
    game.newGame(seed);
  };
  document.getElementById('start-btn')!.addEventListener('click', start, { once: true });
  if (params.has('autostart')) start();

  // 自動テスト・デバッグ用
  (window as unknown as { __game: Game }).__game = game;
}

main();
