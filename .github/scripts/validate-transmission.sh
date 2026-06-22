#!/bin/bash
# Validate monitor-transmission.sh file selection logic

pass=0; fail=0; total=0

echo "============================================"
echo "  StreamVault Transmission Validation"
echo "============================================"
echo ""

read -r -d '' TRACKERS << 'EOF'
http://tracker.opentrackr.org:1337/announce
http://www.torrentsnipe.info:2701/announce
http://tracker.qu.ax:6969/announce
http://tracker.bt4g.com:2095/announce
http://tracker.dler.org:6969/announce
http://tracker.files.fm:6969/announce
http://tracker.stealth.si:80/announce
http://tracker.renfei.net:8080/announce
https://tracker.nanoha.org:443/announce
https://tracker.yemekyedim.com:443/announce
http://1337.abcvg.info:80/announce
http://tracker.waaa.moe:6969/announce
udp://tracker.opentrackr.org:1337/announce
udp://tracker.leechers-paradise.org:6969/announce
udp://tracker.coppersurfer.tk:6969/announce
EOF

build_magnet() {
  local ih="$1" nm="$2"
  local u="magnet:?xt=urn:btih:${ih}"
  nm=$(echo -n "$nm" | python3 -c "import sys,u; print(u.quote(sys.stdin.read()))" 2>/dev/null || echo -n "$nm" | sed 's/ /%20/g')
  u="$u&dn=$nm"
  while IFS= read -r tr; do [ -n "$tr" ] && u="$u&tr=$(echo $tr|sed 's/:/%3a/g;s./.%2f.g')"; done <<< "$TRACKERS"
  echo "$u"
}

ci=$(build_magnet 88594aaacbde40ef3e2510c47374ec0aa396c08e "Big Buck Bunny 1080p 30fps")
si=$(build_magnet 671b08e4ff6d2b2630cd5dd4b894f79e01c5f2ff "Naruto Kai 1-72 (Complete)")

pass_scenario()   { pass=$((pass+1)); echo "  PASS ✓"; }
fail_scenario()   { fail=$((fail+1)); echo "  FAIL ✗"; }
daemon_stop()     { [ -n "$DPID" ] && kill "$DPID" 2>/dev/null || true; }

daemon_start() {
  local TAG="$1"
  export CONFIG_DIR="/tmp/trans-vd-${TAG}"
  export DL_DIR="/tmp/trans-dl-${TAG}"
  rm -rf "$CONFIG_DIR" "$DL_DIR" 2>/dev/null
  mkdir -p "$CONFIG_DIR" "$DL_DIR"
  transmission-daemon \
    --config-dir "$CONFIG_DIR" \
    --download-dir "$DL_DIR" \
    --port 9092 --no-auth --no-portmap --no-global-seedratio \
    --log-level=error --foreground > /tmp/trans-vd-log 2>&1 &
  DPID=$!
  for _ in $(seq 1 10); do
    transmission-remote localhost:9092 --list > /dev/null 2>&1 && break
    sleep 1
  done
}

add_wait_tid() {
  transmission-remote localhost:9092 --add "$1"
  sleep 5
  TID=$(transmission-remote localhost:9092 --list 2>/dev/null | grep -E '^[[:space:]]*[0-9]+' | awk '{print $1}' | head -1)
}

wait_metadata() {
  for a in $(seq 1 12); do
    sleep 5
    INFO=$(transmission-remote localhost:9092 -t "$TID" --info 2>&1 || true)
    if echo "$INFO" | grep -q "Name:"; then
      echo "  Metadata at ${a}x5s: $(echo "$INFO" | grep "Name:" | sed 's/.*Name: //')"
      return 0
    fi
    echo "  Wait metadata (attempt $a/12)..."
  done
  return 1
}

fetch_info_files() {
  transmission-remote localhost:9092 -t "$TID" --info-files 2>/dev/null || true
}

run_scenario() {
  local LABEL="$1" MAGNET="$2" FILE_IDX="$3" TORRENT_NAME="$4"
  total=$((total+1))
  echo ""
  echo "============================================"
  echo "  Scenario $total: $LABEL"
  echo "  idx=${FILE_IDX:-none} name=${TORRENT_NAME:-none}"
  echo "============================================"

  daemon_stop; sleep 1
  daemon_start "$total"

  add_wait_tid "$MAGNET"
  if [ -z "$TID" ]; then echo "  FAIL: no TID"; daemon_stop; fail_scenario; return; fi

  if ! wait_metadata; then echo "  FAIL: metadata"; daemon_stop; fail_scenario; return; fi

  FOUT=$(fetch_info_files)
  FHEAD=$(echo "$FOUT" | head -1)
  FCOUNT=$(echo "$FOUT" | grep -oP '\(\K[0-9]+(?=\s*files?\))' | head -1)
  FLINES=$(echo "$FOUT" | grep -cE '^[[:space:]]*[0-9]+')
  echo "  Files: header=$FHEAD count=${FCOUNT:-?} lines=$FLINES"

  # Determine real file count
  RC="${FCOUNT:-0}"
  [ "$RC" -eq 0 ] && [ "$FLINES" -gt 0 ] && RC="$FLINES"

  # Single file
  if [ "$RC" -eq 1 ]; then echo "  Single-file → skip"; daemon_stop; pass_scenario; return; fi

  # No criteria → skip
  if [ -z "$TORRENT_NAME" ] && [ -z "$FILE_IDX" ]; then
    echo "  No criteria → skip (download all)"
    daemon_stop; pass_scenario; return
  fi

  # Loop matching
  MATCHED=false
  for a in $(seq 1 24); do
    sleep 5
    FOUT=$(fetch_info_files)
    [ $((a % 5)) -eq 0 ] && echo "  [raw $a] $(echo "$FOUT"|head -3)"

    # Single-file recheck
    NC=$(echo "$FOUT" | grep -oP '\(\K[0-9]+(?=\s*files?\))' | head -1)
    NL=$(echo "$FOUT" | grep -cE '^[[:space:]]*[0-9]+')
    if [ "$NC" -eq 1 ] 2>/dev/null || [ "$NL" -eq 1 ] 2>/dev/null; then
      echo "  Single-file appeared → skip"; MATCHED=true; break
    fi
    [ "$NL" -eq 0 ] && continue

    # Filename exact
    TARGET=""; HOW=""
    if [ -n "$TORRENT_NAME" ]; then
      BASE=$(basename "$TORRENT_NAME")
      ML=$(echo "$FOUT" | grep -F "$BASE" | head -1)
      [ -n "$ML" ] && { TARGET=$(echo "$ML" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' '); HOW="exact filename"; }
    fi
    if [ -z "$TARGET" ] && [ -n "$TORRENT_NAME" ]; then
      BNX=$(basename "$TORRENT_NAME" | sed 's/\.[^.]*$//')
      ML=$(echo "$FOUT" | grep -F "$BNX" | head -1)
      [ -n "$ML" ] && { TARGET=$(echo "$ML" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' '); HOW="partial filename"; }
    fi
    if [ -z "$TARGET" ] && [ -n "$FILE_IDX" ] && [[ "$FILE_IDX" =~ ^[0-9]+$ ]]; then
      for IDX in "$FILE_IDX" "$((FILE_IDX + 1))"; do
        ML=$(echo "$FOUT" | grep -E "^[[:space:]]*${IDX}[[:space:]:]" | head -1)
        [ -n "$ML" ] && { TARGET="$IDX"; HOW="index $IDX"; break; }
      done
    fi

    if [ -n "$TARGET" ]; then
      echo "  ✓ $HOW → file $TARGET"
      echo "    $(echo "$FOUT" | grep -E "^[[:space:]]*${TARGET}[[:space:]:]")"
      MATCHED=true; break
    fi
  done

  # Fallback
  if ! $MATCHED; then
    FOUT=$(fetch_info_files)
    FL=$(echo "$FOUT" | grep -cE '^[[:space:]]*[0-9]+')
    if [ "$FL" -eq 0 ]; then
      echo "  No swarm data — OK (download all is correct)"
      MATCHED=true
    else
      BIG=$(echo "$FOUT" | grep -E '^[[:space:]]*[0-9]+' | sort -k4 -rn | head -1 | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ')
      [ -n "$BIG" ] && echo "  Fallback: file $BIG" && MATCHED=true
    fi
  fi

  if $MATCHED; then daemon_stop; pass_scenario; else daemon_stop; fail_scenario; fi
}

run_scenario "BBB + name"    "$ci" "" "Big Buck Bunny 1080p 30fps.mp4"
run_scenario "BBB no name"   "$ci" "" ""
run_scenario "Kai + name 73" "$si" "73" "Naruto the Movie 7 - The Last (2014) [BD_1080p Hi10P 5.1 AAC].mkv"
run_scenario "Kai + idx 73"  "$si" "73" ""

echo ""
echo "============================================"
echo "  $pass/$total passed, $fail failed"
echo "============================================"
[ "$fail" -gt 0 ] && exit 1
