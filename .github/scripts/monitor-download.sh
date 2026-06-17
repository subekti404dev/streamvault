#!/bin/bash
# monitor-download.sh — Run aria2c with periodic progress callbacks
# Usage: monitor-download.sh <job_id> <callback_url> <callback_token> <magnet_uri> <file_idx>

set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:?Missing file_idx}"

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
  --bt-enable-lpd=true \
  --bt-max-peers=100 \
  ${TRACKERS:+--bt-tracker="$TRACKERS"} \
  "$MAGNET_URI" > download.log 2>&1 &
ARIA_PID=$!

# Set a trap to clean up
trap "kill $ARIA_PID 2>/dev/null; exit" EXIT INT TERM

# Monitor progress while aria2c runs
LAST_PCT=-1
while kill -0 $ARIA_PID 2>/dev/null; do
  # Parse aria2c summary: look for line like "[#dc51c8 45.2MiB/1.2GiB(3%) CN:10 SD:5 DL:2.5MiB]"
  SUMMARY=$(grep -oP '\[\#\w+ \K[0-9.]+[KMGTP]?i?B?/[0-9.]+[KMGTP]?i?B?\(\d+%\)' download.log 2>/dev/null | tail -1)

  if [ -n "$SUMMARY" ]; then
    # Extract percentage from "...(50%)" pattern
    PCT=$(echo "$SUMMARY" | grep -oP '\(\K\d+(?=%)')
    if [ -n "$PCT" ] && [ "$PCT" != "$LAST_PCT" ]; then
      LAST_PCT=$PCT
      callback "progress" "{\"phase\":\"download\",\"progress_pct\":$PCT}"
    fi
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
