#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.nvm/nvm.sh"
nvm use 24
export NODE_ENV=production
export PORT=3002
export APP_URL=http://127.0.0.1:3002
exec node --watch-path=build build/server/index.js
