// Network ids come from the deploy tooling's record of the testnet.
import testnet from '../../../deploy/testnet.json';

export const NODE: string = testnet.node;
export const BEACON: string = testnet.beacon;
export const TOKEN: string = testnet.token;
export const UNIT = 1_000_000; // TEST-RNG atoms per RNG
export const REPO = 'https://github.com/RandAOLabs/rng';
