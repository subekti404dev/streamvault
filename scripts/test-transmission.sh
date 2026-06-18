#!/bin/bash
# test-transmission.sh — Test monitor-transmission.sh locally in Docker
# Usage: ./scripts/test-transmission.sh [magnet_infohash]
#
# Uses same tracker list as backend/src/api/search.rs DEFAULT_TRACKERS

set -euo pipefail

# Default: Big Buck Bunny (CC0, public domain)
INFOHASH="${1:-dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c}"

# Build tracker list from backend code
TRACKERS=(
  "http://tracker.opentrackr.org:1337/announce"
  "http://www.torrentsnipe.info:2701/announce"
  "http://tracker.qu.ax:6969/announce"
  "http://tracker.bt4g.com:2095/announce"
  "http://tracker.dler.org:6969/announce"
  "http://tracker2.dler.org:80/announce"
  "https://tracker.yemekyedim.com:443/announce"
  "https://tracker.bt4g.com:443/announce"
  "https://tracker.7471.top:443/announce"
  "https://shahidrazi.online:443/announce"
  "udp://tracker.opentrackr.org:1337/announce"
  "udp://tracker.openbittorrent.com:6969/announce"
  "udp://open.stealth.si:80/announce"
  "udp://tracker.torrent.eu.org:451/announce"
  "udp://tracker.moeking.me:6969/announce"
  "udp://explodie.org:6969/announce"
  "udp://exodus.desync.com:6969/announce"
  "udp://tracker1.bt.moack.co.kr:80/announce"
  "udp://tracker.bitsearch.to:1337/announce"
  "udp://tracker-udp.gbitt.info:80/announce"
  "udp://p4p.arenabg.com:1337/announce"
  "udp://movies.zsw.ca:6969/announce"
  "udp://opentracker.i2p.rocks:6969/announce"
  "udp://tracker.ccp.ovh:6969/announce"
)

# Build magnet URI
MAGNET="magnet:?xt=urn:btih:${INFOHASH}"
for tr in "${TRACKERS[@]}"; do
  MAGNET+="&tr=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$tr', safe=''))")"
done

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Local Transmission Test ==="
echo "InfoHash: $INFOHASH"
echo "Trackers: ${#TRACKERS[@]}"
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
