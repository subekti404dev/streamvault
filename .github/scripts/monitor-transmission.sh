#!/bin/bash
# monitor-transmission.sh — Run transmission-daemon with progress callbacks
# Usage: monitor-transmission.sh <job_id> <callback_url> <callback_token> <magnet_uri> [file_idx]
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:-}"
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
  --no-global-seedratio \
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
  # Wait for daemon to actually stop before removing config
  if [ -n "$DAEMON_PID" ]; then
    wait "$DAEMON_PID" 2>/dev/null || true
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$CONFIG_DIR"
}
trap cleanup INT TERM EXIT

# Add torrent
echo "Adding torrent: $MAGNET_URI"
transmission-remote localhost:9092 --add "$MAGNET_URI"

# If file_idx is specified, select only that file (0-based → 1-based)
if [ -n "$FILE_IDX" ] && [[ "$FILE_IDX" =~ ^[0-9]+$ ]]; then
  TID=$(transmission-remote localhost:9092 --list 2>/dev/null | grep -E '^[[:space:]]*[0-9]+' | awk '{print $1}' | head -1)
  if [ -z "$TID" ]; then
    echo "  WARNING: Could not find torrent ID, downloading all files"
  else
    echo "Selecting only file index $FILE_IDX from torrent $TID..."
    # Wait for metadata to load (magnet links need DHT/PEX — up to 30s)
    META_READY=false
    for attempt in $(seq 1 12); do
      sleep 5
      INFO_OUT=$(transmission-remote localhost:9092 -t "$TID" --info 2>&1 || true)
      if echo "$INFO_OUT" | grep -q "Name:"; then
        META_READY=true
        break
      fi
      echo "  Waiting for metadata (attempt $attempt/12)..."
    done

    if ! $META_READY; then
      echo "  WARNING: Metadata not loaded after 60s, downloading all files"
    else
      # transmission-remote --info-files outputs:
      #   stderr: summary lines (skip)
      #   stdout: header "#  Done Priority..." then entries like "0  Partial ..."
      FILE_OUT=$(transmission-remote localhost:9092 -t "$TID" --info-files 2>/dev/null || true)
      # Count file entries — match "0  Partial" (tabular) or "0:  0%" (colon) or "1   0.0%  None"
      # Exclude header line (starts with "ID" or "#") and metadata lines (emoji/text before number)
      FILE_COUNT=$(echo "$FILE_OUT" | grep -cE '^[[:space:]]*[0-9]+[[:space:]]' || true)
      FILE_COUNT=${FILE_COUNT:-0}

      # File list may arrive AFTER name metadata — wait for it
      if [ "$FILE_COUNT" -eq 0 ] 2>/dev/null; then
        echo "  Metadata name loaded but no files yet — waiting for file list..."
        for attempt in $(seq 1 12); do
          sleep 5
          FILE_COUNT=$(echo "$FILE_OUT" | grep -cE '^[[:space:]]*[0-9]+[[:space:]]' || true)
          FILE_COUNT=${FILE_COUNT:-0}
          if [ "$FILE_COUNT" -gt 0 ] 2>/dev/null; then
            echo "  File list received!"
            break
          fi
          echo "  Still waiting (attempt $attempt/12)..."
        done
      fi

      echo "  Detected $FILE_COUNT files:"
      echo "$FILE_OUT" | grep -E '^[[:space:]]*[0-9]+[[:space:]]' | head -20

      if [ "$FILE_COUNT" -gt 0 ] 2>/dev/null; then
        # Detect indexing: colon format (0:, 1:) = 0-based; tabular (1  , 2  ) = 1-based
        FIRST_ENTRY=$(echo "$FILE_OUT" | grep -m1 '^[[:space:]]*[0-9]')
        FIRST_NUM=$(echo "$FIRST_ENTRY" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ')
        if [ "$FIRST_NUM" = "0" ]; then
          TARGET=$FILE_IDX                 # 0-based format — use directly
        else
          TARGET=$((FILE_IDX + 1))         # 1-based format — convert
        fi
        transmission-remote localhost:9092 -t "$TID" -G all > /dev/null 2>&1 || true
        transmission-remote localhost:9092 -t "$TID" -g "$TARGET" > /dev/null 2>&1 || true
        echo "  Deselected all, selected only file $TARGET of $FILE_COUNT (idx $FILE_IDX)"
        transmission-remote localhost:9092 -t "$TID" --start > /dev/null 2>&1 || true
      else
        echo "  WARNING: Could not parse file list, downloading all files"
      fi
  fi
fi
  fi

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
    # Skip non-numeric values (n/a before metadata loads)
    if [[ "$DONE_PCT" =~ ^[0-9]+$ ]] && [ "$DONE_PCT" -le 100 ]; then
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
