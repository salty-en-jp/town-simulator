import { defineConfig, type Plugin } from 'vite';

// 公開版だけに CSP（読み込んでよいものの決まり）を入れる。
// 万一スクリプトが紛れ込んでも動かないようにする保険（docs/SECURITY_PLAN.md の 2）。
// 開発サーバーはインラインのスクリプトを使うので入れない。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

/**
 * オフラインで起動できるようにする（サービスワーカー）。
 * ビルドでできたファイルの一覧を書き込んだ sw.js を作る。
 * ・ページ（index.html）はネット優先：つながっていれば最新版、つながらなければしまっておいた版
 * ・ほかのファイル（名前にハッシュ付き）はしまっておいた物を優先
 */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      // 先にしまうのはプログラム（js・css）だけ。フォントは数百個に分かれていて大きい（13MB）ので、
      // 画面で実際に使われた分だけを、使われたときにしまう
      const files = Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f));
      const fonts = Object.keys(bundle).filter((f) => f.endsWith('.woff2'));
      const extra = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
      const list = [...extra, ...files.filter((f) => f !== 'index.html')];
      let h = 0;
      for (const f of list) for (let i = 0; i < f.length; i++) h = (Math.imul(h, 31) + f.charCodeAt(i)) | 0;
      const cache = `tsunagumachi-${(h >>> 0).toString(36)}`;
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: SW_SOURCE.replace('__CACHE__', cache).replace('__FILES__', JSON.stringify(list)).replace('__FONTS__', JSON.stringify(fonts)),
      });
    },
  };
}

const SW_SOURCE = `// ツナグマチのサービスワーカー（ビルドで自動生成）
const CACHE = '__CACHE__';
const FILES = __FILES__;
// フォントの残り（woff2）。起動に必要な分を先にしまったあと、裏でゆっくりしまう
const FONTS = __FONTS__;
async function warmFonts() {
  const c = await caches.open(CACHE);
  for (const f of FONTS) {
    try {
      if (!(await c.match(f, { ignoreVary: true }))) await c.add(f);
    } catch (e) {
      return; // つながらなくなったらやめる（使ったときにしまう）
    }
  }
}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tsunagumachi-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        warmFonts();
      }),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // ページ：ネット優先（最新版を見せる）。つながらなければしまっておいた版
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./', { ignoreVary: true }).then((r) => r || caches.match(req, { ignoreVary: true }))),
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;

// GitHub Pages では /town-simulator/ に置かれる
export default defineConfig({
  base: process.env.BASE_PATH ?? '/town-simulator/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
  plugins: [csp(), serviceWorker()],
});
