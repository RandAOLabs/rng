import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Which network the site reads: DEPLOY_STATE=../deploy/soak.json picks another
// deploy record; the default is the public testnet.
const network = JSON.parse(fs.readFileSync(path.resolve(__dirname, process.env.DEPLOY_STATE || '../deploy/testnet.json'), 'utf8'));

// Relative base: the build is served from an Arweave path, not a domain root.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  define: { __NETWORK__: JSON.stringify({ node: network.node, beacon: network.beacon, token: network.token, timelock: network.timelock ?? '' }) },
});
