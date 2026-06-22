#!/bin/bash
# monitor-transmission.sh — Run transmission-daemon with progress callbacks
# Usage: monitor-transmission.sh <job_id> <callback_url> <callback_token> <magnet_uri> [file_idx] [torrent_name]
JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:-}"
TORRENT_NAME="${6:-}"
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
  if [ -n "$DAEMON_PID" ]; then
    wait "$DAEMON_PID" 2>/dev/null || true
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$CONFIG_DIR"
}
trap cleanup INT TERM EXIT

# Add torrent — start downloading immediately so file list populates
echo "Adding torrent: $MAGNET_URI"
transmission-remote localhost:9092 --add "$MAGNET_URI"

# Get torrent ID
TID=$(transmission-remote localhost:9092 --list 2>/dev/null | grep -E '^[[:space:]]*[0-9]+' | awk '{print $1}' | head -1)
if [ -z "$TID" ]; then
  echo "WARNING: Could not find torrent ID"
else
  echo "Torrent ID: $TID"

  # Wait for metadata name to load (magnet links need DHT/PEX)
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
    echo "  WARNING: Metadata not loaded after 60s — downloading all files"
  else
    echo "  Metadata loaded, waiting for file list to populate..."
    TARGET=""

    # Check file count from `--info-files` header: "Name (N files):"
    FILE_OUT=$(transmission-remote localhost:9092 -t "$TID" --info-files 2>/dev/null || true)
    FILE_COUNT=$(echo "$FILE_OUT" | grep -oP '\(\K[0-9]+(?=\s*files?\))' | head -1)
    if [ -z "$FILE_COUNT" ]; then
      FILE_COUNT=0
    fi
    echo "  File count from --info-files header: $FILE_COUNT"

    # Single-file or no-file: skip selection (already downloading all)
    if [ "$FILE_COUNT" -le 1 ]; then
      echo "  Single-file or no-file torrent — downloading entire torrent"
    else

    # Wait for target file to appear in --info-files (up to 120s)
    for attempt in $(seq 1 24); do
      sleep 5
      FILE_OUT=$(transmission-remote localhost:9092 -t "$TID" --info-files 2>/dev/null || true)

      # Debug: print raw every 5th attempt
      if [ $((attempt % 5)) -eq 0 ]; then
        echo "  [debug] --info-files raw output (attempt $attempt):"
        echo "$FILE_OUT" | head -10
        echo "  [debug] ---"
      fi

      # Strategy 1: match by filename (if TORRENT_NAME provided)
      if [ -z "$TARGET" ] && [ -n "$TORRENT_NAME" ]; then
        BASE=$(basename "$TORRENT_NAME")
        MATCH_LINE=$(echo "$FILE_OUT" | grep -F "$BASE" | head -1)
        if [ -n "$MATCH_LINE" ]; then
          TARGET=$(echo "$MATCH_LINE" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ')
          echo "  ✓ Matched by filename: file $TARGET → $(echo "$MATCH_LINE" | awk '{print $(NF-1), $NF}')"
          break
        fi
        # Try partial match without extension
        BASE_NX=$(basename "$TORRENT_NAME" | sed 's/\.[^.]*$//')
        MATCH_LINE=$(echo "$FILE_OUT" | grep -F "$BASE_NX" | head -1)
        if [ -n "$MATCH_LINE" ]; then
          TARGET=$(echo "$MATCH_LINE" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ')
          echo "  ✓ Matched by partial name: file $TARGET → $(echo "$MATCH_LINE" | awk '{print $(NF-1), $NF}')"
          break
        fi
      fi

      # Strategy 2: match by file index (try both 0-based and 1-based)
      if [ -z "$TARGET" ] && [ -n "$FILE_IDX" ] && [[ "$FILE_IDX" =~ ^[0-9]+$ ]]; then
        for IDX in "$FILE_IDX" "$((FILE_IDX + 1))"; do
          MATCH_LINE=$(echo "$FILE_OUT" | grep -E "^[[:space:]]*${IDX}[[:space:]:]" | head -1)
          if [ -n "$MATCH_LINE" ]; then
            TARGET="$IDX"
            echo "  ✓ Matched by index: file $TARGET → $(echo "$MATCH_LINE" | awk '{print $(NF-1), $NF}') (FE idx=$FILE_IDX)"
            break 2
          fi
        done
      fi

      # Check if file list appeared with any entries
      if echo "$FILE_OUT" | grep -qE '^[[:space:]]*[0-9]+'; then
        echo "  File list appeared ($(echo "$FILE_OUT" | grep -cE '^[[:space:]]*[0-9]+') files, no match yet — continuing download until match or timeout)"
      fi
    done

    if [ -n "$TARGET" ]; then
      echo "  Target file found at index $TARGET, selecting..."
      echo "  Detected file list:"
      echo "$FILE_OUT" | grep -E '^[[:space:]]*[0-9]+' | head -10
      # Pause torrent briefly, select only target file, resume
      transmission-remote localhost:9092 -t "$TID" --stop > /dev/null 2>&1 || true
      sleep 1
      transmission-remote localhost:9092 -t "$TID" -G all > /dev/null 2>&1 || true
      transmission-remote localhost:9092 -t "$TID" -g "$TARGET" > /dev/null 2>&1 || true
      echo "  Deselected all, selected only file $TARGET"
      transmission-remote localhost:9092 -t "$TID" --start > /dev/null 2>&1 || true
    else
      echo "  WARNING: Could not identify target file — downloading all files"
    fi
  fi  # end multi-file selection
  fi  # end else META_READY
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

# Verify downloaded files
echo "=== Downloaded files ==="
ls -lahR ./downloads/ | head -60
echo "=== End download listing ==="
