#!/usr/bin/env bash
# Pack the validator image's build context: deploy/pack-validator.sh <out.tgz>
set -euo pipefail
cd "$(dirname "$0")/.."
tar --force-local -czf "$1" package.json provider vendor node_modules/@noble
echo "$1"
