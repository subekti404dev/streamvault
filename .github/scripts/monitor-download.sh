#!/bin/bash
# monitor-download.sh — Run aria2c with periodic progress callbacks
# Usage: monitor-download.sh <job_id> <callback_url> <callback_token> <magnet_uri> <file_idx>

set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:?Missing file_idx}"

# Abort if the torrent has no activity for this many seconds.
# GitHub Actions can look "stuck" when DHT/trackers find no peers.
MAX_IDLE_SECONDS="${MAX_IDLE_SECONDS:-300}"
MAX_TOTAL_SECONDS="${MAX_TOTAL_SECONDS:-7200}"

callback() {
  local endpoint="$1"
  local payload="$2"
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$payload" \
    "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${endpoint}" > /dev/null 2>&1 || true
}

# Get public trackers
TRACKERS=$(curl -sSf --connect-timeout 5 "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt" 2>/dev/null | tr '\n' ',' || echo "")
if [ -z "$TRACKERS" ]; then
  TRACKERS="udp://tracker.opentrackr.org:1337/announce,udp://tracker.torrent.eu.org:451/announce,udp://open.tracker.cl:1337/announce,udp://tracker.altrosky.nl:6969/announce,http://tracker.bt4g.com:2095/announce"
fi

mkdir -p ./downloads

# Start aria2c in background
aria2c --seed-time=0 \
  --select-file="$FILE_IDX" \
  --dir=./downloads \
  --summary-interval=5 \
  --console-log-level=notice \
  --connect-timeout=30 \
  --max-connection-per-server=4 \
  --split=4 \
  --max-concurrent-downloads=1 \
  --retry-wait=5 \
  --max-tries=5 \
  --enable-dht=true \
  --dht-listen-port=6881-6999 \
  --enable-dht6=true \
  --dht-message-timeout=10 \
  --enable-peer-exchange=true \
  --bt-enable-lpd=true \
  --bt-max-peers=100 \
  --bt-stop-timeout="$MAX_IDLE_SECONDS" \
  --bt-metadata-only=false \
  --file-allocation=none \
  ${TRACKERS:+--bt-tracker="$TRACKERS"} \
  "$MAGNET_URI" > download.log 2>&1 &
ARIA_PID=$!

echo "aria2c PID: $ARIA_PID"
echo "Max idle before abort: ${MAX_IDLE_SECONDS}s"
echo "Max total runtime: ${MAX_TOTAL_SECONDS}s"

# Start callback so dashboard shows "Download 0%" immediately
callback "progress" "{\"phase\":\"download\",\"progress_pct\":0}"

# Set a trap to clean up aria2c if the script is killed
trap "kill $ARIA_PID 2>/dev/null; exit" INT TERM

START_TS=$(date +%s)
LAST_PROGRESS_TS=$START_TS
LAST_PCT=-1

while kill -0 $ARIA_PID 2>/dev/null; do
  NOW=$(date +%s)

  if (( NOW - START_TS > MAX_TOTAL_SECONDS )); then
    echo "Download timed out after ${MAX_TOTAL_SECONDS}s" >&2
    kill $ARIA_PID 2>/dev/null || true
    wait $ARIA_PID 2>/dev/null || true
    exit 124
  fi

  # Parse aria2c summary. Examples:
  # [#dc51c8 0B/0B CN:0 SD:0 DL:0B]
  # [#dc51c8 45.2MiB/1.2GiB(3%) CN:10 SD:5 DL:2.5MiB]
  SUMMARY=$(tail -n 30 download.log 2>/dev/null | tr '\r' '\n' | grep -Eo '\[[#][^]]+\]' | tail -1 || true)

  PCT=""
  if [ -n "$SUMMARY" ]; then
    # Prefer explicit percentage from aria2c summary
    PCT=$(printf '%s' "$SUMMARY" | sed -nE 's/.*\(([0-9]+)%\).*/\1/p')

    # If aria2c only shows 0B/0B or no percent yet, send tiny heartbeat when bytes > 0
    if [ -z "$PCT" ]; then
      DOWN=$(printf '%s' "$SUMMARY" | sed -nE 's/.*[[:space:]]([0-9.]+[KMGTPE]?i?B?)\/.*/\1/p')
      if [ -n "$DOWN" ] && [ "$DOWN" != "0B" ]; then
        PCT=1
      fi
    fi
  fi

  # Fallback heartbeat from downloaded file size if summary parsing fails
  if [ -z "$PCT" ]; then
    DOWNLOADED_BYTES=$(find ./downloads -type f -not -name "*.log" -not -name "*.torrent" -not -name "*.aria2" -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
    if [ "$DOWNLOADED_BYTES" -gt 0 ]; then
      PCT=1
    fi
  fi

  if [ -n "$PCT" ]; then
    if [ "$PCT" -gt 100 ]; then
      PCT=100
    fi

    if [ "$PCT" -gt 0 ]; then
      LAST_PROGRESS_TS=$NOW
    fi

    if [ "$PCT" != "$LAST_PCT" ]; then
      LAST_PCT=$PCT
      callback "progress" "{\"phase\":\"download\",\"progress_pct\":$PCT}"
      echo "Download progress: ${PCT}% (${SUMMARY:-no aria2c summary yet})"
    fi
  fi

  if (( NOW - LAST_PROGRESS_TS > MAX_IDLE_SECONDS )); then
    echo "No download progress for ${MAX_IDLE_SECONDS}s. Aborting aria2c." >&2
    kill $ARIA_PID 2>/dev/null || true
    wait $ARIA_PID 2>/dev/null || true
    exit 124
  fi

  sleep 5
done

wait $ARIA_PID
EXIT_CODE=$?

# Report completion/failure
if [ $EXIT_CODE -eq 0 ]; then
  callback "progress" "{\"phase\":\"download\",\"progress_pct\":100}"
  echo "Download complete"
else
  echo "Download failed with exit code $EXIT_CODE" >&2
  exit $EXIT_CODE
fi
