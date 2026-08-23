import { defineConfig } from 'vite';

// demo build: `index.html` at the repo root → dist-demo (static, deployable)
export default defineConfig({
  base: './',
  build: { outDir: 'dist-demo', emptyOutDir: true },
  test: { environment: 'node' },
});
