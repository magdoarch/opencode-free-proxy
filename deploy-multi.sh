#!/bin/bash
# deploy-multi.sh — Batch deploy multiple proxy instances to Vercel across different regions
# Usage:
#   ./deploy-multi.sh 1 10      # Deploy instances oc1 to oc10
#   ./deploy-multi.sh 1 60 myteam   # Deploy oc1 to oc60 under team scope 'myteam'

set -uo pipefail

START=${1:-1}
END=${2:-10}
TEAM=${3:-""}
CONCURRENCY=4

BASE_DIR="/tmp/ocdeploy"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$BASE_DIR/logs"

# 19 Official Vercel Serverless Regions
REGIONS=(arn1 bom1 cdg1 cle1 cpt1 dub1 fra1 gru1 hkg1 hnd1 iad1 icn1 kix1 lhr1 pdx1 sfo1 sin1 syd1 yul1)

mkdir -p "$LOG_DIR"

echo "=========================================================="
echo "  Deploying oc${START} to oc${END} (Concurrency: ${CONCURRENCY})"
[ -n "$TEAM" ] && echo "  Scope / Team: ${TEAM}"
echo "=========================================================="

deploy_instance() {
  local num=$1
  local name="oc${num}"
  local dir="$BASE_DIR/$name"
  local log="$LOG_DIR/$name.log"

  local rand_idx=$((RANDOM % ${#REGIONS[@]}))
  local region="${REGIONS[$rand_idx]}"

  {
    mkdir -p "$dir/api"
    cp "$SRC_DIR/api/index.js" "$dir/api/index.js"
    cp "$SRC_DIR/package.json" "$dir/package.json"

    cat > "$dir/vercel.json" <<EOF
{
  "\$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["$region"],
  "rewrites": [
    { "source": "/(.*)", "destination": "/api" }
  ]
}
EOF

    local scope_args=""
    [ -n "$TEAM" ] && scope_args="--scope $TEAM"

    echo "[$name] Linking project..."
    (cd "$dir" && npx -y vercel link -p "$name" $scope_args -y 2>&1 | tail -1)

    echo "[$name] Deploying to $region..."
    (cd "$dir" && npx -y vercel deploy --prod --yes $scope_args 2>&1 | tail -3)

    echo "[$name] Done!"
  } >> "$log" 2>&1
}

for i in $(seq "$START" "$END"); do
  deploy_instance "$i" &
  while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do
    sleep 2
  done
done

wait
echo "All deployments completed! Logs saved to: $LOG_DIR"
