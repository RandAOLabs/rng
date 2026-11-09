// Exact message templates for every request type (docs/USE.md), checked
// against protocol/beacon/beacon.lua (Fast), protocol/beacon/anyhonest.lua,
// lib/fair.lua + protocol/fair/fair.lua and lib/js/fair-client.ts. Pure.

export type TemplateIds = { token: string; fast: string; anyHonest: string; fair: string; subscriptionConsumer?: string; scheduler?: string };
export type TemplatePrices = {
  /** Atoms per RNG. */
  unit: number;
  fast: { request: number };
  anyHonest: { request: number; subscription: number; subscriptionRounds: number };
  /** Fair play: one beacon request, in atoms. */
  fairRequestAtoms: number;
};

type Template = {
  id: string; tier: "local" | "fast" | "any-honest" | "fair"; sender: string; target: string;
  tags: Record<string, string>; notes: string; result: string;
};

const atoms = (rng: number, unit: number) => String(BigInt(rng) * BigInt(unit));

export function requestTemplates(ids: TemplateIds, prices: TemplatePrices) {
  const fastAtoms = atoms(prices.fast.request, prices.unit);
  const ahAtoms = atoms(prices.anyHonest.request, prices.unit);
  const templates: Template[] = [
    { id: "fast.pay-and-request", tier: "fast", sender: "wallet or process", target: ids.token,
      tags: { Action: "Transfer", Recipient: ids.fast, Quantity: fastAtoms, "X-Request-Id": "<1-128 chars, unique per sender>" },
      notes: "Credits the sender and requests in the same slot at today's price. X-For is ignored: the payer is the requester. A refused request leaves the credit (Withdraw).",
      result: `Wallet: round = Fast beaconstate.seen["<sender>|<request id>"]; then beaconstate.rounds["<round>"] (last 32) or beaconhistory -> slot -> beaconround. value = sha256("hyperbeam/rng/fast/v2/request|" + round.value + "|" + sender + "|" + requestId). A process also gets RNG-Result.` },
    { id: "fast.fund", tier: "fast", sender: "anyone", target: ids.token,
      tags: { Action: "Transfer", Recipient: ids.fast, Quantity: "<atoms; whole RNG are credited, dust refunded>", "X-For": "<account to credit, default the sender>" },
      notes: "Prepays a Fast balance at the prices in force now (pay at deposit, up to 8 price batches).",
      result: "Balance in Fast beaconstate.balances[<account>] (whole RNG)." },
    { id: "fast.request", tier: "fast", sender: "process (or wallet) with a Fast balance", target: ids.fast,
      tags: { Action: "Request-Random", Tier: "fast", "Request-Id": "<1-128 chars>" },
      notes: "Reply { requestId, round, price, balance }. Binds to the next unsigned round. lib/rng.lua: rng.config{ beacon = <fast> }; rng.request(msg, { tier = \"beacon\", on = \"<handler>\" }).",
      result: 'Process receives Action RNG-Result, Data { round, signature, derivation: "hyperbeam/rng/fast/v2/request", results: [{ requestId, round, value }] }. Unsigned after 30 min: refund and RNG-Error { error: "Round-Abandoned" }.' },
    { id: "any-honest.pay-and-request", tier: "any-honest", sender: "wallet or process", target: ids.token,
      tags: { Action: "Transfer", Recipient: ids.anyHonest, Quantity: ahAtoms, "X-Request-Id": "<1-128 chars, unique per sender>" },
      notes: "lib/js payAndRequestTags(beacon, atoms, requestId). Binds to the round taking commits. A refused request leaves the credit.",
      result: 'Wallet: read beaconround-0..7 (round r is beaconround-<r % 8>), find requests[] entry { requester, requestId, value }; recheck value = sha256("hyperbeam/rng/any-honest/v1/request|" + round.value + "|" + requester + "|" + requestId) (lib/js findRequest). Older: timelockhistory.' },
    { id: "any-honest.fund", tier: "any-honest", sender: "anyone", target: ids.token,
      tags: { Action: "Transfer", Recipient: ids.anyHonest, Quantity: "<atoms>", "X-For": "<account to credit, default the sender>" },
      notes: "Prepays an Any-Honest balance (whole RNG, pay at deposit).",
      result: "Read it with Action Balance { Account } (reply: account, balance, stake, earnedAtoms)." },
    { id: "any-honest.request", tier: "any-honest", sender: "process (or wallet) with a beacon balance", target: ids.anyHonest,
      tags: { Action: "Request-Random", Tier: "any-honest", "Request-Id": "<1-128 chars>" },
      notes: "Reply { requestId, round, price, balance }. Request ids are remembered 10 min: a resend is { duplicate: true }, not charged. lib/rng.lua rng.request cannot target this beacon (it sends Tier \"beacon\").",
      result: 'Process receives Action RNG-Result, Data { round, tier: "any-honest", value, results: [{ requestId, round, value }] }. Errors: RNG-Error { error, requestId }.' },
    { id: "any-honest.subscribe", tier: "any-honest", sender: "process only", target: ids.anyHonest,
      tags: { Action: "Subscribe", "Subscription-Id": "<1-128 chars>", Rounds: String(prices.anyHonest.subscriptionRounds) },
      notes: `Costs ${prices.anyHonest.subscription} RNG per ${prices.anyHonest.subscriptionRounds} rounds from the process's balance; Rounds 1 to 31,536,000; at most 16 live per process. Wallets are refused (Process-Required).`,
      result: 'Every covered round: Action RNG-Subscription, Data { round, tier: "any-honest", roundValue, results: [{ subscriptionId, round, value }] }, value = sha256("hyperbeam/rng/subscription/v1|" + roundValue + "|" + subscriptionId + "|" + round).' },
    ...(["fast", "any-honest"] as const).map((tier): Template => ({
      id: `${tier}.withdraw`, tier, sender: "the account", target: tier === "fast" ? ids.fast : ids.anyHonest,
      tags: { Action: "Withdraw", Quantity: "<whole RNG, optional: default all>" },
      notes: "Works at any time, paused or not; newest price batch first.",
      result: "Reply { withdrawn }; the process transfers the RNG back." })),
    { id: "fair.fund", tier: "fair", sender: "anyone (for a game)", target: ids.token,
      tags: { Action: "Transfer", Recipient: ids.fair, Quantity: String(prices.fairRequestAtoms), "X-Fair-Game": "<game wallet or process id>" },
      notes: "lib/js fairFundTags(fair, game, atoms). Atoms; a new game account needs at least one request price or the transfer is refunded.",
      result: "fairaccounts[<game>] = { balance, reserved, nonce } (atoms)." },
    { id: "fair.open", tier: "fair", sender: "the game (wallet or process)", target: ids.fair,
      tags: { Action: "Fair.Open", Session: "<1-64 of A-Z a-z 0-9 _ - . :>", Player: "<player browser key address>" },
      notes: "Reserves one request price from the game's balance, else Game-Unfunded. The allowance lasts 10 min.",
      result: "Reply; the player key may now commit." },
    { id: "fair.commit", tier: "fair", sender: "the player's browser key", target: ids.fair,
      tags: { Action: "Fair.Commit", Game: "<game>", Session: "<session>", Commit: 'sha256("rng/fair/v1/commit|" + game + "|" + session + "|" + secret) for a fresh 32-byte hex secret' },
      notes: "lib/js FairClient.commit(game, session) saves the secret first and retries Not-Opened.",
      result: 'When the batch is bound: fairsessions[<game>] shows status "reveal-due" and revealBy; v = sha256("rng/fair/v1/beacon|" + v_b + "|" + game + "|" + session).' },
    { id: "fair.reveal", tier: "fair", sender: "anyone (normally the player's browser)", target: ids.fair,
      tags: { Action: "Fair.Reveal", Game: "<game>", Session: "<session>", Secret: "<64 hex>", Player: "<player, optional: default the signer>" },
      notes: "Before revealBy (fairWindowMs after binding).",
      result: 'final = sha256("rng/fair/v1/final|" + v + "|" + secret). A process game gets Action Fair-Result { Session, Player, Status, Final, Round, Data }; a wallet game reads fairsessions / fairhistory.' },
    { id: "fair.expire", tier: "fair", sender: "anyone", target: ids.fair,
      tags: { Action: "Fair.Expire", Game: "<game>", Session: "<session>", Player: "<player>" },
      notes: "After revealBy with no reveal. Score a forfeit as the worst outcome.",
      result: 'final = sha256("rng/fair/v1/forfeit|" + v); Fair-Result Status "forfeit".' },
    { id: "fair.withdraw", tier: "fair", sender: "the game", target: ids.fair,
      tags: { Action: "Fair.Withdraw", Nonce: "<greater than the last used>", Quantity: "<atoms, optional: default all free>" },
      notes: "lib/js fairWithdrawTags(nonce, atoms).",
      result: "The fair process transfers the free balance back." },
    { id: "local", tier: "local", sender: "your process", target: "(none)",
      tags: {},
      notes: 'lib/rng.lua: rng.install(msg) seeds math.random, or rng.request(msg, { tier = "local", on = "<handler>" }) runs the handler at once. Free, deterministic, predictable to the sender.',
      result: "Immediate; no message." },
  ];
  return {
    ids, prices,
    sending: "Sign an ANS-104 item with the target as its target; POST <node>/<target>~process@1.0/schedule?codec-device=ans104@1.0, then GET .../push&slot=<slot>; the reply is .../compute&slot=<slot>/results/output/data ({ error } on refusal). aos: ao.send; native compute(): base.results.outbox. No message carries a time.",
    delivery: "Processes receive pushes (RNG-Result, RNG-Subscription, RNG-Error, Fair-Result), believed only as a from-process attested by the shared scheduler. Wallets get no push: they read published round records.",
    templates,
  };
}
