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
  --port 9091 \
  --rpc-port 9092 \
  --no-auth \
  --no-portmap \
  --no-global-seed \
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

while ! $DONE; do
  sleep 5

  STATS=$(transmission-remote localhost:9092 --list 2>/dev/null | grep -E '^[[:space:]]*[0-9]+') || true
  if [ -z "$STATS" ]; then
    continue
  fi

  # Parse Done column (2nd column)
  DONE_PCT=$(echo "$STATS" | awk '{print $2}' | sed 's/%//')
  STATUS=$(echo "$STATS" | awk '{for(i=1;i<=NF;i++) if($i~/^(Downloading|Seeding|Stopped|Finished|Idle)$/) print $i}')

  if [ "$DONE_PCT" != "$LAST_PCT" ] && [ -n "$DONE_PCT" ]; then
    LAST_PCT=$DONE_PCT
    if [ "$DONE_PCT" -le 100 ]; then
      callback "progress" "{\"phase\":\"download\",\"progress_pct\":$DONE_PCT}"
      echo "Download: ${DONE_PCT}% — $STATUS"
    fi
  fi

  if [ "$STATUS" = "Seeding" ] || [ "$STATUS" = "Finished" ] || [ "$STATUS" = "Stopped" ] || [ "$DONE_PCT" = "100" ]; then
    DONE=true
  fi
done

callback "progress" '{"phase":"download","progress_pct":100}'
echo "Download complete"
