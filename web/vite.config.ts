import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base: the build is served from an Arweave path, not a domain root.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: { fs: { allow: ['..'] } },
});
