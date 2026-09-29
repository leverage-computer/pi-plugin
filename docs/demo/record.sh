#!/usr/bin/env bash
# Records every tutorial video. Needs vhs (https://github.com/charmbracelet/vhs),
# Pi, and Bun on your PATH. Run it from the repository root.
set -euo pipefail
cd "$(dirname "$0")/../.."
for tape in docs/demo/0*.tape; do
  echo "Recording ${tape}…"
  vhs "$tape"
done
