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

// GitHub Pages では /town-simulator/ に置かれる
export default defineConfig({
  base: process.env.BASE_PATH ?? '/town-simulator/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
  plugins: [csp()],
});
