import { defineConfig } from 'vite';

// GitHub Pages serves the site at /town-simulator/
export default defineConfig({
  base: process.env.BASE_PATH ?? '/town-simulator/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
});
