#!/usr/bin/env bash
# Install and operate the RandAO provider daemon on the committee nodes.
#
#   deploy/nodes.sh install  <tgz>   copy the daemon to every node
#   deploy/nodes.sh init             create each node's provider wallet + DKG key
#   deploy/nodes.sh dkg              run the key ceremony on all nodes at once (needs $PORT open between nodes)
#   deploy/nodes.sh dkg-offline      same ceremony, deals relayed through this machine over SSH
#   deploy/nodes.sh start            start the daemon (docker, restart unless-stopped)
#   deploy/nodes.sh status | logs    health and recent logs
#   deploy/nodes.sh stop-one|start-one <name>   stop or start one node's daemon (soak chaos)
#
# The daemon runs in node:22-slim with host networking, so each host's own
# firewall decides who can reach port $PORT. Files live in /opt/randao-provider.
set -euo pipefail

# Operator-specific settings live in deploy/nodes.local.sh (untracked), or the
# file named by NODES_FILE:
#   SSH_KEY=~/.ssh/<key>
#   NODES=("1 <name> <host>" "2 <name> <host>" "3 <name> <host>")
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${NODES_FILE:-$HERE/nodes.local.sh}"
KEY="${SSH_KEY:?set SSH_KEY in deploy/nodes.local.sh}"
PORT=7477
BASE=/opt/randao-provider
IMAGE=node:22-slim

ssh_() { ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 "root@$1" "${@:2}"; }
run_() { # ip, daemon command
  ssh_ "$1" "docker run --rm --network host -v $BASE:/srv $IMAGE node /srv/app/provider/daemon.mjs $2 /srv/config.json"
}

case "${1:-}" in
  install)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      scp -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$2" "root@$ip:/tmp/randao-provider.tgz"
      ssh_ "$ip" "mkdir -p $BASE/data && chmod 700 $BASE/data && rm -rf $BASE/app && tar -C $BASE -xzf /tmp/randao-provider.tgz && docker pull -q $IMAGE >/dev/null && echo $name installed"
    done ;;
  config) # config <beacon> <hbNode> <peers.json>: write each node's config.json
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      node -e '
        const [i, beacon, hbNode, peersFile, port] = process.argv.slice(1);
        const peers = JSON.parse(require("fs").readFileSync(peersFile, "utf8")).filter((p) => p.index !== +i);
        console.log(JSON.stringify({ index: +i, n: 3, t: 2, beacon, hbNode, listen: +port, dataDir: "/srv/data", peers }));
      ' "$i" "$2" "$3" "$4" "$PORT" | ssh_ "$ip" "cat > $BASE/config.json"
      echo "$name configured"
    done ;;
  init)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      ssh_ "$ip" "test -f $BASE/config.json || echo '{\"index\":$i,\"dataDir\":\"/srv/data\"}' > $BASE/config.json"
      echo "$(run_ "$ip" init) $ip"
    done ;;
  dkg)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      run_ "$ip" dkg > "/tmp/randao-dkg-$name.log" 2>&1 &
    done
    wait
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      echo "== $name"; tail -n 3 "/tmp/randao-dkg-$name.log"
      ssh_ "$ip" "cat $BASE/data/transcript.json" > "/tmp/randao-transcript-$name.json"
    done ;;
  dkg-offline)
    tmp="$(mktemp -d)"
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      run_ "$ip" dkg-deal >/dev/null
      ssh_ "$ip" "cat $BASE/data/deal-$i.json" > "$tmp/deal-$i.json"
    done
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      for f in "$tmp"/deal-*.json; do
        [ "$(basename "$f")" = "deal-$i.json" ] || ssh_ "$ip" "cat > $BASE/data/$(basename "$f")" < "$f"
      done
      echo "$name $(run_ "$ip" dkg-finish)"
    done
    rm -rf "$tmp" ;;
  start)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      ssh_ "$ip" "docker rm -f randao-provider >/dev/null 2>&1; docker run -d --name randao-provider --restart unless-stopped --network host -v $BASE:/srv $IMAGE node /srv/app/provider/daemon.mjs run /srv/config.json >/dev/null && echo $name started"
    done ;;
  stop-one|start-one) # chaos testing: stop-one <name> / start-one <name>
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      [ "$name" = "$2" ] || continue
      if [ "$1" = stop-one ]; then ssh_ "$ip" "docker stop randao-provider >/dev/null && echo $name stopped"
      else ssh_ "$ip" "docker start randao-provider >/dev/null && echo $name started"; fi
    done ;;
  status)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      echo "$name: $(ssh_ "$ip" "docker ps --filter name=randao-provider --format '{{.Status}}'; curl -s -m 3 http://127.0.0.1:$PORT/health")"
    done ;;
  logs)
    for n in "${NODES[@]}"; do read -r i name ip <<<"$n"
      echo "== $name"; ssh_ "$ip" "docker logs --tail ${2:-15} randao-provider 2>&1"
    done ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
