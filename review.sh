#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it from https://nodejs.org/ and try again." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

if [ ! -f dist/cli.js ]; then
  npm run build
fi

exec node dist/cli.js "$@"
