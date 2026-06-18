#!/bin/bash
# monitor-transmission.sh — Run transmission-daemon with progress callbacks
# Usage: monitor-transmission.sh <job_id> <callback_url> <callback_token> <magnet_uri>
set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"

callback() {
  local endpoint="$1"
  local payload="$2"
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$payload" \
    "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${endpoint}" > /dev/null 2>&1 || true
}

mkdir -p ./downloads

# Stop systemd daemon if running (Ubuntu starts it automatically on install)
sudo systemctl stop transmission-daemon 2>/dev/null || true
sudo pkill -9 transmission-da 2>/dev/null || true
sleep 1

# Config dir
CONFIG_DIR="/tmp/transmission-$$"
mkdir -p "$CONFIG_DIR"

# Start daemon foreground
transmission-daemon \
  --config-dir "$CONFIG_DIR" \
  --download-dir ./downloads \
  --port 9092 \
  --no-auth \
  --no-portmap \
  --no-global-seed \
  --log-level=error \
  --foreground > /tmp/transmission.log 2>&1 &
DAEMON_PID=$!
echo "transmission-daemon PID: $DAEMON_PID"

# Wait for daemon to be ready
for i in $(seq 1 20); do
  if transmission-remote localhost:9092 --list > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Cleanup on exit
cleanup() {
  transmission-remote localhost:9092 --exit > /dev/null 2>&1 || true
  kill $DAEMON_PID 2>/dev/null || true
  rm -rf "$CONFIG_DIR"
}
trap cleanup INT TERM EXIT

# Add torrent
echo "Adding torrent: $MAGNET_URI"
transmission-remote localhost:9092 --add "$MAGNET_URI"

# Wait for metadata to load
sleep 5

# Initial progress
callback "progress" '{"phase":"download","progress_pct":0}'

LAST_PCT=-1
DONE=false
STALL_COUNT=0
MAX_STALL=360          # 30 min no progress → fail (360 × 5s = 1800s)

while ! $DONE; do
  sleep 5

  # Check daemon is still alive
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "transmission-daemon died unexpectedly (exit code: $?)"
    echo "=== transmission.log ==="
    cat /tmp/transmission.log 2>/dev/null || echo "(no log file)"
    echo "=== end transmission.log ==="
    callback "failed" '{"error_message":"transmission-daemon crashed (see CI logs)"}'
    exit 1
  fi

  STATS=$(transmission-remote localhost:9092 --list 2>/dev/null | grep -E '^[[:space:]]*[0-9]+') || true
  if [ -z "$STATS" ]; then
    continue
  fi

  # Parse Done column (2nd column)
  DONE_PCT=$(echo "$STATS" | awk '{print $2}' | sed 's/%//')
  STATUS=$(echo "$STATS" | awk '{for(i=1;i<=NF;i++) if($i~/^(Downloading|Seeding|Stopped|Finished|Idle)$/) print $i}')
  PEERS=$(echo "$STATS" | awk '{print $NF}' | head -1)

  # Stall detection — if progress didn't change, count it
  if [ "$DONE_PCT" = "$LAST_PCT" ] || [ -z "$DONE_PCT" ]; then
    STALL_COUNT=$((STALL_COUNT + 1))
    if [ "$STALL_COUNT" -ge "$MAX_STALL" ]; then
      echo "Download stalled after 30 minutes with no progress (peers: $PEERS)"
      callback "failed" "{\"error_message\":\"Download stalled — no progress for 30 min (peers: $PEERS)\"}"
      exit 1
    fi
  else
    STALL_COUNT=0
  fi

  if [ "$DONE_PCT" != "$LAST_PCT" ] && [ -n "$DONE_PCT" ]; then
    LAST_PCT=$DONE_PCT
    if [ "$DONE_PCT" -le 100 ]; then
      callback "progress" "{\"phase\":\"download\",\"progress_pct\":$DONE_PCT}"
      echo "Download: ${DONE_PCT}% — $STATUS (peers: $PEERS)"
    fi
  fi

  if [ "$STATUS" = "Seeding" ] || [ "$STATUS" = "Finished" ] || [ "$STATUS" = "Stopped" ] || [ "$DONE_PCT" = "100" ]; then
    DONE=true
  fi
done

callback "progress" '{"phase":"download","progress_pct":100}'
echo "Download complete"
