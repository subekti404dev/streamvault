#!/bin/bash
# test-transmission.sh — Test monitor-transmission.sh locally in Docker
# Usage:
#   ./scripts/test-transmission.sh                    # Big Buck Bunny (default)
#   ./scripts/test-transmission.sh <infohash>          # Build magnet with our trackers
#   ./scripts/test-transmission.sh "magnet:?xt=..."   # Use full magnet URI as-is

set -euo pipefail

INPUT="${1:-}"

if [[ "$INPUT" == magnet:* ]]; then
  # Full magnet URI passed as-is
  MAGNET="$INPUT"
elif [ -n "$INPUT" ]; then
  # Infohash — build magnet with our trackers
  TRACKERS=(
    "http://tracker.opentrackr.org:1337/announce"
    "http://tracker.qu.ax:6969/announce"
    "http://tracker.bt4g.com:2095/announce"
    "http://tracker.dler.org:6969/announce"
    "https://tracker.bt4g.com:443/announce"
    "udp://tracker.opentrackr.org:1337/announce"
    "udp://tracker.openbittorrent.com:6969/announce"
    "udp://open.stealth.si:80/announce"
    "udp://tracker.torrent.eu.org:451/announce"
    "udp://explodie.org:6969/announce"
    "udp://exodus.desync.com:6969/announce"
    "udp://tracker.bitsearch.to:1337/announce"
    "udp://p4p.arenabg.com:1337/announce"
    "udp://opentracker.i2p.rocks:6969/announce"
    "udp://tracker.ccp.ovh:6969/announce"
  )
  MAGNET="magnet:?xt=urn:btih:${INPUT}"
  for tr in "${TRACKERS[@]}"; do
    MAGNET+="&tr=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$tr', safe=''))")"
  done
else
  # Default: Big Buck Bunny
  MAGNET="magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Local Transmission Test ==="
echo "Magnet: ${MAGNET:0:120}..."
echo ""

docker run --rm \
  -v "$SCRIPT_DIR/.github/scripts:/scripts:ro" \
  ubuntu:24.04 \
  bash -c '
    apt-get update -qq && apt-get install -y -qq transmission-daemon transmission-cli curl jq > /dev/null 2>&1
    echo "Transmission $(transmission-daemon --version 2>&1 | head -1)"
    echo ""
    bash /scripts/monitor-transmission.sh \
      "test-job-id" \
      "http://localhost:9999" \
      "dummy-token" \
      "'"$MAGNET"'"
  '
