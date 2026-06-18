#!/bin/bash
# upload-to-discord.sh — Upload HLS chunks to Discord channel
# Usage: upload-to-discord.sh <job_id> <callback_url> <callback_token> <hls_dir>
#
# Parses real durations from ffmpeg-generated master.m3u8 and sends them
# in the progress callback so the backend stores accurate durations.

set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
HLS_DIR="${4:?Missing hls_dir}"

DISCORD_API="https://discord.com/api/v10"

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not set" >&2
  exit 1
fi

if [ -z "$DISCORD_CHANNEL_ID" ]; then
  echo "ERROR: DISCORD_CHANNEL_ID not set" >&2
  exit 1
fi

callback() {
  local endpoint="$1"
  local payload="$2"
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$payload" \
    "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${endpoint}" > /dev/null 2>&1 || true
}

# Parse durations from ffmpeg-generated .m3u8 playlist
# Returns: associative array filename -> duration
declare -A CHUNK_DURATIONS
PLAYLIST_FILE="$HLS_DIR/master.m3u8"
if [ -f "$PLAYLIST_FILE" ]; then
  PENDING_DUR=""
  while IFS= read -r line; do
    TRIMMED=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    if [[ "$TRIMMED" == \#EXTINF:* ]]; then
      PENDING_DUR=$(echo "$TRIMMED" | sed 's/#EXTINF://' | cut -d',' -f1)
    elif [[ "$TRIMMED" == *.ts ]]; then
      BASENAME=$(basename "$TRIMMED")
      if [ -n "$PENDING_DUR" ]; then
        CHUNK_DURATIONS["$BASENAME"]="$PENDING_DUR"
      fi
      PENDING_DUR=""
    fi
  done < "$PLAYLIST_FILE"
  echo "Parsed ${#CHUNK_DURATIONS[@]} chunk durations from playlist"
fi

# Collect .ts files sorted
FILES=$(find "$HLS_DIR" -maxdepth 1 -name "*.ts" | sort)
TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
CURRENT=0
FAILED_COUNT=0

echo "Uploading $TOTAL files to Discord..."

for file in $FILES; do
  CURRENT=$((CURRENT + 1))
  BASENAME=$(basename "$file")

  # Get real duration from parsed playlist, fallback to 6.0
  DURATION="${CHUNK_DURATIONS[$BASENAME]:-6.0}"

  echo "[$CURRENT/$TOTAL] Uploading $BASENAME (duration: ${DURATION}s)..."

  # Upload with retry
  ATTEMPT=0
  MAX_ATTEMPTS=5
  DELAY=2
  UPLOADED=false

  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      -F "file=@$file" \
      -F "content=${JOB_ID}:${BASENAME}" \
      "${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages" 2>&1) || true

    # Check for rate limiting
    if echo "$RESPONSE" | jq -e '.retry_after' > /dev/null 2>&1; then
      RETRY_AFTER=$(echo "$RESPONSE" | jq -r '.retry_after')
      RETRY_AFTER=$(echo "$RETRY_AFTER + 1" | bc -l | awk '{printf "%.0f\n", $1}')
      echo "  Rate limited, retrying in ${RETRY_AFTER}s..."
      sleep "$RETRY_AFTER"
      continue
    fi

    # Check for success
    MSG_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
    if [ -n "$MSG_ID" ] && [ "$MSG_ID" != "null" ]; then
      FILE_URL=$(echo "$RESPONSE" | jq -r '.attachments[0].url // empty')

      # Report progress with chunk info including duration
      PCT=$((CURRENT * 100 / TOTAL))
      callback "progress" \
        "{\"phase\":\"upload\",\"progress_pct\":$PCT,\"chunk\":{\"chunk_index\":$CURRENT,\"filename\":\"$BASENAME\",\"discord_url\":\"$FILE_URL\",\"discord_message_id\":\"$MSG_ID\",\"duration_seconds\":$DURATION}}"

      echo "  ✓ Uploaded ($PCT%)"
      UPLOADED=true
      break
    fi

    # Check for error
    ERROR_CODE=$(echo "$RESPONSE" | jq -r '.code // empty')
    echo "  Attempt $ATTEMPT failed: $(echo "$RESPONSE" | jq -r '.message // empty') (code: $ERROR_CODE)"

    if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
      sleep "$DELAY"
      DELAY=$((DELAY * 2))
      [ $DELAY -gt 32 ] && DELAY=32
    fi
  done

  if [ "$UPLOADED" != "true" ]; then
    echo "  ✗ Failed to upload $BASENAME after $MAX_ATTEMPTS attempts"
    callback "progress" \
      "{\"phase\":\"upload\",\"progress_pct\":$PCT,\"chunk\":{\"chunk_index\":$CURRENT,\"filename\":\"$BASENAME\",\"error\":\"upload_failed\"}}"
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi

  # Small delay between files to avoid rate limits
  sleep 0.05
done

echo "Upload complete: $CURRENT files processed, $FAILED_COUNT failed"
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo "WARNING: Some uploads failed" >&2
  exit 1
fi
