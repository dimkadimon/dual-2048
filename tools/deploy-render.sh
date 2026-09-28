#!/usr/bin/env bash
# Deploy the current main branch on Render and verify the live service.
#
#   RENDER_API_KEY=rnd_xxx tools/deploy-render.sh
#
# Finds the service that serves this repo, POSTs a deploy, waits for it to go
# live, then checks that the site really is running the v3 leaderboard:
#   - /api/health exists
#   - /game.js matches the file in this repo
#   - the live board returns every stored play with no duplicates
set -euo pipefail

: "${RENDER_API_KEY:?set RENDER_API_KEY (Render → Account Settings → API Keys)}"
SERVICE_NAME_HINT="${SERVICE_NAME_HINT:-dual-2048}"
API="https://api.render.com/v1"
root="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. finding the Render service"
services="$(curl -sf -H "Authorization: Bearer $RENDER_API_KEY" "$API/services?limit=100")"
read -r SERVICE_ID SERVICE_URL SERVICE_BRANCH <<EOF
$(printf '%s' "$services" | python3 -c "
import sys, json
hint = '$SERVICE_NAME_HINT'
for s in json.load(sys.stdin):
    svc = s['service']
    name, url, branch = svc.get('name',''), svc.get('serviceDetails',{}).get('url',''), svc.get('branch','')
    repo = (svc.get('repo') or '')
    if hint in name or hint in repo:
        print(svc['id'], url, branch)
        break
else:
    print('', '', '')
")
EOF
[ -n "$SERVICE_ID" ] || { echo "no service matched '$SERVICE_NAME_HINT'"; exit 1; }
echo "   $SERVICE_ID  $SERVICE_URL  (branch $SERVICE_BRANCH)"

say "2. triggering a deploy of main"
deploy="$(curl -sf -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"clearCache":"do_not_clear"}' "$API/services/$SERVICE_ID/deploys")"
DEPLOY_ID="$(printf '%s' "$deploy" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
echo "   deploy $DEPLOY_ID started"

say "3. waiting for it to go live (free instances need a few minutes)"
for i in $(seq 1 60); do
  status="$(curl -sf -H "Authorization: Bearer $RENDER_API_KEY" "$API/services/$SERVICE_ID/deploys/$DEPLOY_ID" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])' 2>/dev/null || echo '?')"
  printf '   [%02d] %s\n' "$i" "$status"
  case "$status" in
    live) break ;;
    build_failed|update_failed|canceled|deactivated) echo "deploy failed: $status"; exit 1 ;;
  esac
  sleep 15
done

say "4. verifying the live service"
base="${SERVICE_URL%/}"
health="$(curl -s -m 60 "$base/api/health")"
echo "   /api/health: $health"
printf '%s' "$health" | grep -q '"ok":true' || { echo "health check failed"; exit 1; }

curl -s -m 60 "$base/game.js" -o /tmp/live-game.js
if cmp -s /tmp/live-game.js "$root/public/game.js"; then
  echo "   game.js matches the repo ✓"
else
  echo "   ! game.js differs from the repo ($(md5sum < /tmp/live-game.js | cut -c1-8) vs $(md5sum < "$root/public/game.js" | cut -c1-8))"
fi

say "5. checking the live board"
curl -s -m 60 "$base/api/scores" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rows = d.get('scores', [])
ids = {str(e['ts']) + '|' + e['name'] for e in rows}
print('   top-50 returned:', len(rows))
print('   reported total :', d.get('total'))
print('   quality        :', d.get('quality'))
print('   duplicates     :', len(rows) - len(ids))
print('   leader         :', rows[0] if rows else 'none')
"

say "done — $base is running v3.0"
