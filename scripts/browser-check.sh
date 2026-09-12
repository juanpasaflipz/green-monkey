#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.nvm/nvm.sh"
nvm use 24
export TEST_BASE_URL=http://127.0.0.1:3002
export TEST_PRODUCTION=1
node --input-type=module -e 'let ready=false; for(let i=0;i<30;i++){try{ready=(await fetch("http://127.0.0.1:3002/api/health")).ok;}catch{} if(ready)break;await new Promise(r=>setTimeout(r,500));}if(!ready)throw Error("Compiled local server is not ready on port 3002");'
npm run test:browser -- "$@"
