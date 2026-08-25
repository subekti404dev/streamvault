#!/bin/bash
# upload-to-telegram.sh — Upload HLS chunks to a Telegram channel (Bot API)
# Usage: upload-to-telegram.sh <job_id> <callback_url> <callback_token> <hls_dir>
#
# Mirrors upload-to-discord.sh: ffprobe real durations, per-chunk progress
# callback with tg_file_id. Bot API sendDocument supports files up to 50MB
# (chunks are ~1MB), so no MTProto/session needed.

set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
HLS_DIR="${4:?Missing hls_dir}"

if [ -z "$TG_BOT_TOKEN" ]; then
  echo "ERROR: TG_BOT_TOKEN not set" >&2
  exit 1
fi

if [ -z "$TG_CHANNEL_ID" ]; then
  echo "ERROR: TG_CHANNEL_ID not set" >&2
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

# Collect .ts files sorted
FILES=$(find "$HLS_DIR" -maxdepth 1 -name "*.ts" | sort)
TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')

# Parse durations from actual .ts files using ffprobe (m3u8 EXTINF is
# unreliable when -hls_segment_size overrides -hls_time).
declare -A CHUNK_DURATIONS
echo "Probing chunk durations with ffprobe..."
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  BASENAME=$(basename "$file")
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file" 2>/dev/null || echo "0")
  # ponytail: skip absurd values — ffprobe should always succeed
  if [ -n "$DUR" ] && [ "$DUR" != "0" ] && [ "$(echo "$DUR > 0" | bc -l 2>/dev/null)" = "1" ]; then
    CHUNK_DURATIONS["$BASENAME"]="$DUR"
  fi
done <<< "$FILES"
echo "Probed ${#CHUNK_DURATIONS[@]} chunk durations from files"

CURRENT=0
FAILED_COUNT=0

echo "Uploading $TOTAL files to Telegram..."

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  CURRENT=$((CURRENT + 1))
  BASENAME=$(basename "$file")

  # Get real duration from parsed playlist, fallback to 10.0
  DURATION="${CHUNK_DURATIONS[$BASENAME]:-10.0}"

  echo "[$CURRENT/$TOTAL] Uploading $BASENAME (duration: ${DURATION}s)..."

  ATTEMPT=0
  MAX_ATTEMPTS=5
  DELAY=2
  UPLOADED=false

  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    RESPONSE=$(curl -s \
      -F "chat_id=$TG_CHANNEL_ID" \
      -F "caption=${JOB_ID}:${BASENAME}" \
      -F "document=@$file" \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument" 2>&1) || true

    # Check for rate limiting (Bot API returns parameters.retry_after)
    if echo "$RESPONSE" | jq -e '.parameters.retry_after' > /dev/null 2>&1; then
      RETRY_AFTER=$(echo "$RESPONSE" | jq -r '.parameters.retry_after')
      echo "  Rate limited, retrying in ${RETRY_AFTER}s..."
      sleep "$RETRY_AFTER"
      continue
    fi

    # Check for success
    FILE_ID=$(echo "$RESPONSE" | jq -r '.result.document.file_id // empty')
    if [ -n "$FILE_ID" ] && [ "$FILE_ID" != "null" ]; then
      PCT=$((CURRENT * 100 / TOTAL))
      callback "progress" \
        "{\"phase\":\"upload\",\"progress_pct\":$PCT,\"chunk\":{\"chunk_index\":$CURRENT,\"filename\":\"$BASENAME\",\"tg_file_id\":\"$FILE_ID\",\"duration_seconds\":$DURATION}}"

      echo "  ✓ Uploaded ($PCT%)"
      UPLOADED=true
      break
    fi

    # Check for error
    ERROR_CODE=$(echo "$RESPONSE" | jq -r '.error_code // empty')
    echo "  Attempt $ATTEMPT failed: $(echo "$RESPONSE" | jq -r '.description // empty') (code: $ERROR_CODE)"

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

  # Pace uploads to stay under Telegram's send rate limit and avoid 429 penalties.
  # Override with TG_UPLOAD_DELAY (seconds) if your bot is allowed to go faster.
  sleep "${TG_UPLOAD_DELAY:-0.8}"
done <<< "$FILES"

echo "Upload complete: $CURRENT files processed, $FAILED_COUNT failed"
if [ "$FAILED_COUNT" -gt 0 ]; then
  exit 1
fi
