#!/bin/zsh -l
set -eu
ROOT="${0:A:h}"
exec node "$ROOT/scripts/local/runtime.mjs" start
