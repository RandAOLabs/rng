// Network ids come from the deploy record chosen at build time (vite.config.ts).
declare const __NETWORK__: { node: string; beacon: string; token: string; timelock: string };

export const NODE: string = __NETWORK__.node;
export const BEACON: string = __NETWORK__.beacon;
export const TOKEN: string = __NETWORK__.token;
export const TIMELOCK: string = __NETWORK__.timelock;
export const UNIT = 1_000_000; // TEST-RNG atoms per RNG
export const REPO = 'https://github.com/RandAOLabs/rng';
