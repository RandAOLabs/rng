#!/usr/bin/env bash
# The live Any-Honest beacon (lua-patch@1.0) to a successor on wasm-patch@1.0,
# and fair play with it. docs/BEACON_WASM_MIGRATION.md. One stage per call, in
# order; each one reads back what it did and stops on a surprise.
#
#   deploy/migrate-beacon-wasm.sh check      read-only: node, old beacon, wallet path, funds
#   deploy/migrate-beacon-wasm.sh spawn      SPAWN the new beacon, genesis (predecessor = old), DAO, treasury, bonds
#   deploy/migrate-beacon-wasm.sh handover   old: Gov.Set-Successor; new: Resend-Successor-Ack; validators move
#   deploy/migrate-beacon-wasm.sh reserve    old: Gov.Move-Reserve (the heartbeat now pays on the new beacon)
#   deploy/migrate-beacon-wasm.sh fair       SPAWN fair play on the new beacon, configure, DAO, float
#   deploy/migrate-beacon-wasm.sh repoint    the cracker and randao.net's console onto the new ids (no node restart)
#   deploy/migrate-beacon-wasm.sh verify     deploy.mjs verify + the validators on the new beacon
#   deploy/migrate-beacon-wasm.sh old claim|exit|status   each validator on the OLD beacon, own wallet on its host
#
# Env: HB_WALLET (the deployer, DA9qhP25), PARALITH_MONO (a checkout holding the
# pinned wasm-lua runtime, deploy/wasm-runtime.json). spawn and fair are
# irreversible; handover and reserve move the validators and the reserve.
set -euo pipefail
cd "$(dirname "$0")/.."
export HB_NODE=${HB_NODE:-https://rng-hb.tylerw.ai}
export RNG_STATE=${RNG_STATE:-deploy/v3-main.json}
: "${HB_WALLET:?HB_WALLET: the deployer wallet}" "${PARALITH_MONO:?PARALITH_MONO: checkout with the pinned runtime}"
OLD=Q_rRJ-CtkETtUFtBhJNwymY5m_uD6uPx_mTWO4spDCQ
D() { node deploy/deploy.mjs "$@"; }
st() { node -e "console.log(JSON.parse(require('fs').readFileSync('$RNG_STATE','utf8'))$1 ?? '')"; }
info() { curl -fsS -H 'accept: application/json' "$HB_NODE/$1~process@1.0/now/${2:-beaconinfo}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let j=JSON.parse(s);j=typeof j.body==='string'?JSON.parse(j.body):j;console.log(JSON.stringify(eval('j'+process.argv[1])))})" "$3"; }
die() { echo "STOP: $*" >&2; exit 1; }

case "${1:-}" in
  check)
    [ "$(info $OLD beaconinfo .gov.wallet)" = true ] || die "the wallet no longer co-owns the old beacon: this needs the DAO"
    [ "$(info $OLD beaconinfo .successor)" = '""' ] || die "the old beacon already names a successor"
    echo "old beacon: round $(info $OLD beaconinfo .round), reserve $(info $OLD beaconinfo .foundationReserveAtoms) atoms, wallet co-owns"
    [ "$(st .beacon)" = "$OLD" ] || die "state beacon is $(st .beacon), not $OLD"
    RNG_DRY_RUN=1 D spawn-beacon --replace >/dev/null && echo "spawn-beacon --replace: dry run ok (wasm-patch, pinned runtime)"
    echo "Check the node build carries env.wp_rng_* (hyperbeam 547c0f57d) before 'spawn'." ;;
  spawn)
    [ "$(st .beacon)" = "$OLD" ] || die "already spawned: state beacon is $(st .beacon)"
    D spawn-beacon --replace
    NEW=$(st .beacon); echo "new beacon $NEW"
    node -e "const p=require('./deploy/v3-params.json');p.predecessor='$OLD';require('fs').writeFileSync('deploy/v3-params-successor.json',JSON.stringify(p,null,2)+'\n')"
    D genesis-configure deploy/v3-params-successor.json
    [ "$(info $NEW beaconinfo .predecessor)" = "\"$OLD\"" ] || die "new beacon does not name the old one as predecessor"
    D set-dao beacon
    D fund-treasury
    D bond-for 100000 deploy/anyhonest-validators.json
    echo "spawned and funded: $NEW (validators bonded, not moved yet)" ;;
  handover)
    NEW=$(st .beacon); [ "$NEW" != "$OLD" ] || die "spawn first"
    D gov-old Gov.Set-Successor "Successor=$NEW"
    D resend-ack
    [ "$(info $OLD beaconinfo .successorAck)" = true ] || die "the old beacon has not recorded the successor's ack"
    echo "old beacon names $NEW, acknowledged: the validators move once they owe it nothing" ;;
  reserve)
    NEW=$(st .beacon); [ "$(info $OLD beaconinfo .successorAck)" = true ] || die "handover first"
    D gov-old Gov.Move-Reserve "Successor=$NEW"
    echo "old reserve now $(info $OLD beaconinfo .foundationReserveAtoms), new $(info $NEW beaconinfo .foundationReserveAtoms)" ;;
  fair)
    NEW=$(st .beacon); [ "$NEW" != "$OLD" ] || die "spawn first"
    D spawn-fair --replace
    D configure-fair
    [ "$(info "$(st .fair)" fairinfo .beacon)" = "\"$NEW\"" ] || die "the new fair does not name the new beacon"
    D set-dao fair
    D fund-fair 40
    echo "fair play $(st .fair) on $NEW" ;;
  repoint)
    # The cracker (RNG host) and randao.net's console (Paralith host) read their
    # ids from config; each is backed up, rewritten and its container recreated.
    # No node restart. SSH_KEY: the committee key (deploy/nodes.sh).
    NEW=$(st .beacon); FAIR=$(st .fair); [ "$NEW" != "$OLD" ] || die "spawn first"
    S="ssh -i ${SSH_KEY:?SSH_KEY} -o BatchMode=yes -o IdentitiesOnly=yes"
    $S root@138.201.220.159 "cd /opt/rng-cracker/data && cp config.json config.json.bak-\$(date +%s) \
      && docker run --rm -v /opt/rng-cracker/data:/d node:22-slim node -e \
      \"const f='/d/config.json',c=JSON.parse(require('fs').readFileSync(f));c.beacon='$NEW';require('fs').writeFileSync(f,JSON.stringify(c,null,2))\" \
      && docker restart rng-cracker >/dev/null && echo cracker on \$(grep -o '\"beacon\": *\"[^\"]*' config.json)"
    node site/scripts/console-env.mjs
    grep -q "RNG_ANYHONEST_ID=$NEW" site/deploy/native-testnet.env && grep -q "RNG_FAIR_ID=$FAIR" site/deploy/native-testnet.env \
      || die "console-env did not write the new ids"
    $S root@176.9.219.106 "cd /opt/rng-console-deploy && cp native-testnet.env native-testnet.env.bak-\$(date +%s)"
    scp -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes site/deploy/native-testnet.env root@176.9.219.106:/opt/rng-console-deploy/native-testnet.env
    $S root@176.9.219.106 "docker compose -f /opt/rng-console-deploy/compose.yaml up -d --force-recreate >/dev/null 2>&1; sleep 5; \
      curl -fsS https://randao.net/api/anyhonest | head -c 300"
    echo ;;
  verify)
    NEW=$(st .beacon)
    info "$NEW" beaconinfo ".validators.map(v=>[v.address.slice(0,8),v.ready,v.bond])"
    D verify ;;
  old)
    # Each validator, with its own wallet where it lives (the node's keys
    # volume; the file never leaves the host), on the OLD beacon:
    #   old claim   earnings to the validator wallet
    #   old exit    Exit, then (once its rounds are done and the exit floor has
    #               passed) run again for Finalize-Exit: the bond comes back.
    case "${2:-}" in claim|exit|status) ;; *) die "old claim|exit|status" ;; esac
    NEW=$(st .beacon)
    S="ssh -i ${SSH_KEY:?SSH_KEY} -o BatchMode=yes -o IdentitiesOnly=yes"
    tar -czf /tmp/rng-validator-cli.tgz validator
    for h in 176.9.219.106 49.12.125.122 138.201.220.159; do
      scp -q -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes /tmp/rng-validator-cli.tgz "root@$h:/tmp/"
      $S "root@$h" "set -e; D=/tmp/rng-old-exit; rm -rf \$D; mkdir -p \$D/cli \$D/v; tar -xzf /tmp/rng-validator-cli.tgz -C \$D/cli; \
        echo '{\"beacon\":\"$NEW\",\"hbNode\":\"$HB_NODE\",\"dataDir\":\".\"}' > \$D/v/config.json; \
        docker run --rm --network host -v \$D:/w -v /opt/runerealm-hb/keys/rng-validator-wallet.json:/w/v/validator-wallet.json:ro \
          -w /w/cli/validator node:22-slim node anyhonest-validator.mjs $2 --beacon $OLD /w/v/config.json; rm -rf \$D /tmp/rng-validator-cli.tgz"
    done ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
