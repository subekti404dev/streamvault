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

mkdir -p ./hls

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
  echo "First 100 bytes (hex):" >&2
  hexdump -C -n 100 "$INPUT_FILE" | head -5 >&2
  exit 1
fi

# Build HLS variants based on source height
VARIANTS=""
if [ "$SOURCE_HEIGHT" -ge 2160 ]; then
  VARIANTS="-var_stream_map \"v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3\""
  RESOLUTIONS=("1920:1080" "1280:720" "854:480" "640:360")
  BITRATES=("5000k" "2500k" "1000k" "600k")
  MAXRATES=("7500k" "3750k" "1500k" "900k")
  BUFSIZES=("10000k" "5000k" "2000k" "1200k")
elif [ "$SOURCE_HEIGHT" -ge 1080 ]; then
  VARIANTS="-var_stream_map \"v:0,a:0 v:1,a:1 v:2,a:2\""
  RESOLUTIONS=("1280:720" "854:480" "640:360")
  BITRATES=("2500k" "1000k" "600k")
  MAXRATES=("3750k" "1500k" "900k")
  BUFSIZES=("5000k" "2000k" "1200k")
else
  VARIANTS="-var_stream_map \"v:0,a:0 v:1,a:1\""
  RESOLUTIONS=("854:480" "640:360")
  BITRATES=("1000k" "600k")
  MAXRATES=("1500k" "900k")
  BUFSIZES=("2000k" "1200k")
fi

# Get total duration in seconds
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=n:0 "$INPUT_FILE" 2>/dev/null || echo "0")
if [ "$DURATION" = "0" ] || [ -z "$DURATION" ]; then
  echo "WARNING: Could not determine duration, trying alternative method" >&2
  DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" 2>/dev/null || echo "0")
fi

# Convert duration to integer (remove decimal part) for bash arithmetic
DURATION_INT="${DURATION%.*}"
if [ -z "$DURATION_INT" ] || [ "$DURATION_INT" = "0" ]; then
  DURATION_INT=0
fi

echo "Input: $INPUT_FILE, Duration: ${DURATION}s (${DURATION_INT}s int), Source height: $SOURCE_HEIGHT" >&2

# Build ffmpeg filter complex
FILTER_COMPLEX=""
STREAM_MAP=()
MAP_FLAGS=""
STREAMS_OUT=""
INDEX=0
for ((i=0; i<${#RESOLUTIONS[@]}; i++)); do
  RES="${RESOLUTIONS[$i]}"
  W="${RES%%:*}"
  H="${RES##*:}"
  if [ $INDEX -gt 0 ]; then
    FILTER_COMPLEX+=","
  fi
  FILTER_COMPLEX+="[v:0]scale=w=$W:h=$H:force_original_aspect_ratio=decrease,setdar=16/9[v$INDEX]"
  STREAM_MAP+=(-map "[v$INDEX]" -map "a:0")
  STREAMS_OUT+=" -c:v:${INDEX} libx264 -b:v:${INDEX} ${BITRATES[$i]} -maxrate:v:${INDEX} ${MAXRATES[$i]} -bufsize:v:${INDEX} ${BUFSIZES[$i]} -preset fast -g 48 -keyint_min 48 -sc_threshold 0"
  STREAMS_OUT+=" -c:a:${INDEX} aac -b:a:${INDEX} 128k -ac 2"
  INDEX=$((INDEX + 1))
done

# Write master playlist
{
  for ((i=0; i<${#RESOLUTIONS[@]}; i++)); do
    RES="${RESOLUTIONS[$i]}"
    W="${RES%%:*}"
    H="${RES##*:}"
    echo "#EXT-X-STREAM-INF:BANDWIDTH=${BITRATES[$i]%k}000,RESOLUTION=${W}x${H}"
    echo "${W}x${H}.m3u8"
  done
} > ./hls/master.m3u8

echo "Starting transcode..." >&2

# Run ffmpeg with progress pipe for periodic reporting
# ffmpeg writes "out_time_us=..." to the progress URL every frame
# We parse it and calculate percentage based on duration
ffmpeg -y -i "$INPUT_FILE" \
  -filter_complex "$FILTER_COMPLEX" \
  "${STREAM_MAP[@]}" \
  $STREAMS_OUT \
  -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename "./hls/seg_%v_%03d.ts" \
  -progress pipe:1 \
  ./hls/%v.m3u8 2>&1 | tee /tmp/ffmpeg.log | while IFS== read -r key value; do
  if [ "$key" = "out_time_us" ]; then
    # out_time_us is in microseconds, total duration in seconds
    USEC="$value"
    if [ -n "$DURATION_INT" ] && [ "$DURATION_INT" -gt 0 ] && [ "$USEC" -gt 0 ]; then
      PCT=$(( USEC / 10000 / DURATION_INT ))
      if [ "$PCT" -gt 100 ]; then PCT=100; fi
      callback "progress" "{\"phase\":\"transcode\",\"progress_pct\":$PCT}"
    fi
  fi
done

# Capture ffmpeg exit code (first command in pipe)
EXIT_CODE=${PIPESTATUS[0]}

if [ $EXIT_CODE -eq 0 ]; then
  callback "progress" "{\"phase\":\"transcode\",\"progress_pct\":100}"
  echo "Transcode complete"
else
  echo "Transcode failed with exit code $EXIT_CODE" >&2
  exit $EXIT_CODE
fi
