// Writes site/deploy/native-testnet.env (the console's process ids) from the
// deployment record, so the console follows a redeploy without a hand edit.
// Record: RNG_STATE, default deploy/v3-main.json. fresh-deploy runs this at
// the end of the RNG stage; deploy/test and site/tests check the file matches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const ENV_FILE = path.join(ROOT, "site/deploy/native-testnet.env");
export const STATE_FILE = path.join(ROOT, "deploy/v3-main.json");

/** The env file's text for a deployment record. RNG_BEACON_ID is the Fast tier; RNG_ANYHONEST_ID the beacon. */
export function consoleEnv(deploy) {
  const rows = [
    ["RNG_NODE_URL", deploy.node],
    ["RNG_BEACON_ID", deploy.fast],
    ["RNG_TOKEN_ID", deploy.token],
    ["RNG_ANYHONEST_ID", deploy.beacon],
    ["RNG_DAO_ID", deploy.dao],
    ["RNG_NETWORK_LABEL", "Mainnet"],
    ["RNG_FAIR_ID", deploy.fair],
  ];
  for (const [k, v] of rows) if (!v) throw new Error(`deployment record has no value for ${k}`);
  return rows.map(([k, v]) => `${k}=${v}\n`).join("");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = path.resolve(process.env.RNG_STATE || STATE_FILE);
  fs.writeFileSync(ENV_FILE, consoleEnv(JSON.parse(fs.readFileSync(state, "utf8"))));
  console.log(`wrote ${path.relative(ROOT, ENV_FILE)} from ${path.relative(ROOT, state)}`);
}
