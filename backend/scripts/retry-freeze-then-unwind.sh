#!/bin/bash
# Not committed, session-only. Retries the real Cleanverse freeze
# (testnet-full-lifecycle.ts --phase freeze) every 30s until it succeeds
# or a deadline passes, then immediately runs flag, waits out the real
# 90s grace period, then runs unwind. Real testnet/sandbox calls only.
set -uo pipefail
cd "$(dirname "$0")/.."

DEADLINE=$(( $(date +%s) + 90*60 ))

echo "[retry-loop] starting, deadline in 90 minutes"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  echo "[retry-loop] $(date -u +%H:%M:%S) attempting freeze..."
  if npx tsx scripts/testnet-full-lifecycle.ts --phase freeze 2>&1 | tee /tmp/freeze-attempt.log | tail -5; then
    if ! grep -q "failed:" /tmp/freeze-attempt.log; then
      echo "[retry-loop] FREEZE SUCCEEDED, proceeding to flag"
      npx tsx scripts/testnet-full-lifecycle.ts --phase flag 2>&1 | tail -20
      echo "[retry-loop] waiting 95s for real grace period..."
      sleep 95
      echo "[retry-loop] running unwind"
      npx tsx scripts/testnet-full-lifecycle.ts --phase unwind 2>&1 | tail -40
      echo "[retry-loop] DONE: freeze -> flag -> unwind complete on 0xd4D9F9787557Df143e962F1A42B2adA38687355A"
      exit 0
    fi
  fi
  sleep 30
done
echo "[retry-loop] deadline reached, Cleanverse freeze never succeeded"
exit 1
