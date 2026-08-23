import { defineConfig } from 'vite';

// library build: src/index.ts → dist/threetiles.js (three stays external)
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'threetiles' },
    rollupOptions: { external: ['three'] },
    sourcemap: true,
  },
});
