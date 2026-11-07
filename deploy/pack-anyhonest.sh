#!/usr/bin/env bash
# Pack the Any-Honest validator image build context (repo-root relative).
set -euo pipefail
cd "$(dirname "$0")/.."
tar --force-local --exclude=validator/test -czf "$1" validator node_modules/@noble
echo "$1"
