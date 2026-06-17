#!/bin/bash
# upload-to-discord.sh — Upload HLS chunks to Discord channel
# Usage: upload-to-discord.sh <job_id> <callback_url> <callback_token> <hls_dir>

set -e

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
HLS_DIR="${4:?Missing hls_dir}"

DISCORD_API="https://discord.com/api/v10"

# Wait for Discord token to be provided via env
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
    "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${endpoint}" > /dev/null
}

# Collect files sorted
FILES=$(find "$HLS_DIR" -maxdepth 1 \( -name "*.ts" -o -name "*.m3u8" \) | sort)
TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
CURRENT=0

echo "Uploading $TOTAL files to Discord..."

for file in $FILES; do
  CURRENT=$((CURRENT + 1))
  BASENAME=$(basename "$file")

  echo "[$CURRENT/$TOTAL] Uploading $BASENAME..."

  # Upload with retry
  ATTEMPT=0
  MAX_ATTEMPTS=5
  DELAY=2

  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      -F "file=@$file" \
      -F "content=${JOB_ID}:${BASENAME}" \
      "${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages" 2>&1)

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

      # Report progress
      PCT=$((CURRENT * 100 / TOTAL))
      callback "progress" \
        "{\"phase\":\"upload\",\"progress_pct\":$PCT,\"chunk\":{\"chunk_index\":$CURRENT,\"filename\":\"$BASENAME\",\"discord_url\":\"$FILE_URL\",\"discord_message_id\":\"$MSG_ID\"}}"

      echo "  ✓ Uploaded ($PCT%)"
      break
    fi

    # Check for error
    ERROR_CODE=$(echo "$RESPONSE" | jq -r '.code // empty')
    echo "  Attempt $ATTEMPT failed: $(echo "$RESPONSE" | jq -r '.message // empty') (code: $ERROR_CODE)"

    if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
      sleep "$DELAY"
      DELAY=$((DELAY * 2))
      [ $DELAY -gt 32 ] && DELAY=32
    else
      echo "  ✗ Failed to upload $BASENAME after $MAX_ATTEMPTS attempts"
      callback "progress" \
        "{\"phase\":\"upload\",\"progress_pct\":$PCT,\"chunk\":{\"chunk_index\":$CURRENT,\"filename\":\"$BASENAME\",\"error\":\"upload_failed\"}}"
    fi
  done

  # Small delay to avoid hitting rate limits
  sleep 0.05
done

echo "Upload complete: $CURRENT files uploaded"
