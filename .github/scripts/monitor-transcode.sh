#!/bin/bash
# monitor-transcode.sh — Run ffmpeg HLS transcode with periodic progress callbacks
# Usage: monitor-transcode.sh <job_id> <callback_url> <callback_token> <input_file> <source_height>

set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
INPUT_FILE="${4:?Missing input_file}"
SOURCE_HEIGHT="${5:-0}"

callback() {
  local endpoint="$1"
  local payload="$2"
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$payload" \
    "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${endpoint}" > /dev/null 2>&1 || true
}

HLS_DIR="./hls"
LOG_FILE="/tmp/ffmpeg_transcode.log"
mkdir -p "$HLS_DIR"

# Validate input file exists and is a valid media file
if [ ! -f "$INPUT_FILE" ]; then
  echo "ERROR: Input file not found: $INPUT_FILE" >&2
  echo "Contents of ./downloads:" >&2
  find ./downloads -type f | head -20 >&2
  exit 1
fi

echo "Input file exists: $INPUT_FILE" >&2
echo "File size: $(du -h "$INPUT_FILE" | cut -f1)" >&2
echo "File type: $(file -b "$INPUT_FILE" | head -c 100)" >&2

if ! ffprobe -v error "$INPUT_FILE" > /dev/null 2>&1; then
  echo "ERROR: ffprobe failed on input file" >&2
  echo "ffprobe output:" >&2
  ffprobe -v error "$INPUT_FILE" 2>&1 >&2
  exit 1
fi

# Get total duration ONCE (as integer)
TOTAL_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT_FILE" 2>/dev/null | cut -d. -f1)
TOTAL_DURATION=${TOTAL_DURATION:-600}
echo "Input: $INPUT_FILE, Duration: ${TOTAL_DURATION}s, Source height: $SOURCE_HEIGHT" >&2

# Determine target resolution based on source
if [ "$SOURCE_HEIGHT" -ge 2160 ]; then
  TARGET_HEIGHT=1080
elif [ "$SOURCE_HEIGHT" -ge 1080 ]; then
  TARGET_HEIGHT=720
else
  TARGET_HEIGHT=480
fi
echo "Target resolution: ${TARGET_HEIGHT}p" >&2

echo "Starting transcode..." >&2
callback "progress" '{"phase":"transcode","progress_pct":0}'

# Run ffmpeg in background, log to file
rm -f "$LOG_FILE"
ffmpeg -y \
  -i "$INPUT_FILE" \
  -c:v libx264 -preset ultrafast -b:v 2500k -maxrate 3000k -bufsize 5000k \
  -c:a aac -b:a 128k \
  -vf "scale=-2:$TARGET_HEIGHT" \
  -force_key_frames "expr:eq(mod(n,72),0)" \
  -hls_time 6 \
  -hls_segment_filename "${HLS_DIR}/seg_%04d.ts" \
  -hls_playlist_type vod \
  "${HLS_DIR}/master.m3u8" 2> "$LOG_FILE" &
FFMPEG_PID=$!
echo "[transcode] ffmpeg PID=$FFMPEG_PID" >&2

# Parse log file every 2 seconds for progress
LAST_REPORT=0
while kill -0 "$FFMPEG_PID" 2>/dev/null; do
  sleep 2
  LAST_LINE=$(tail -1 "$LOG_FILE" 2>/dev/null || true)
  if echo "$LAST_LINE" | grep -q "time="; then
    TIMESTAMP=$(echo "$LAST_LINE" | grep -oP 'time=\K[\d:.]+' || true)
    if [ -n "$TIMESTAMP" ]; then
      SECONDS_ELAPSED=$(echo "$TIMESTAMP" | awk -F: '{ print ($1 * 3600) + ($2 * 60) + $3 }')
      PCT=$(echo "scale=1; $SECONDS_ELAPSED * 100 / $TOTAL_DURATION" | bc 2>/dev/null || echo "0")
      PCT=$(echo "$PCT" | awk '{if($1>99)$1=99; if($1<1)$1=1; print $1}')
      PCT_INT=${PCT%.*}
      
      NOW=$(date +%s)
      if [ $(( NOW - LAST_REPORT )) -ge 5 ]; then
        callback "progress" "{\"phase\":\"transcode\",\"progress_pct\":$PCT_INT}"
        LAST_REPORT=$NOW
        echo "[transcode] ${PCT}% (${TIMESTAMP})" >&2
      fi
    fi
  fi
done

# Wait for ffmpeg to exit and get exit code
wait "$FFMPEG_PID"
EXIT_CODE=$?

echo "[transcode] ffmpeg exit code: $EXIT_CODE" >&2
echo "[transcode] --- last 10 log lines ---" >&2
tail -10 "$LOG_FILE" >&2
echo "[transcode] --- end log ---" >&2

if [ $EXIT_CODE -eq 0 ]; then
  callback "progress" '{"phase":"transcode","progress_pct":100}'
  TOTAL_CHUNKS=$(ls "${HLS_DIR}"/seg_*.ts 2>/dev/null | wc -l)
  echo "Transcode complete: $TOTAL_CHUNKS chunks"
else
  echo "Transcode failed with exit code $EXIT_CODE" >&2
  exit $EXIT_CODE
fi
