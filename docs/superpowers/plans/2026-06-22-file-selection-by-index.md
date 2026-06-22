# File Selection by Index Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate reliance on `torrent_name` filename matching; use `file_idx` exclusively for file selection in transmission and pipeline detect step.

**Architecture:** 6 independent tasks across 3 subsystems — backend type fix + trigger cleanup, frontend custom magnet cleanup, CI monitor.sh refactor + pipeline detect step + validation harness update. Each produces a working, testable artifact.

**Tech Stack:** Bash (CI scripts), TypeScript/Bun (backend), Svelte 5 (frontend)

---

### Task 1: Backend — Prioritize behaviorHints.fileIdx in search.ts

**Files:**
- Modify: `backend-bun/src/api/search.ts:236` (TorrentioStream type)
- Modify: `backend-bun/src/api/search.ts:258` (fileIdx extraction)

- [ ] **Step 1: Update TorrentioStream type to include fileIdx in behaviorHints**

Edit `backend-bun/src/api/search.ts` line 236. Change `behaviorHints` to include optional `fileIdx`:

```typescript
interface TorrentioStream {
  infoHash?: string;
  name?: string;
  title?: string;
  size?: number;
  fileIdx?: number;
  behaviorHints?: { filename?: string; fileIdx?: number };
}
```

- [ ] **Step 2: Update fileIdx extraction to check behaviorHints first**

Edit `backend-bun/src/api/search.ts` line 258:

```typescript
const fileIdx = 
  typeof stream.behaviorHints?.fileIdx === "number" ? stream.behaviorHints.fileIdx :
  typeof stream.fileIdx === "number" ? stream.fileIdx : 0;
```

- [ ] **Step 3: Verify TypeScript types compile**

```bash
cd backend-bun && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add backend-bun/src/api/search.ts
git commit -m "fix: prioritize behaviorHints.fileIdx over top-level fileIdx"
```

---

### Task 2: Backend — Send empty torrent_name in trigger.ts

**Files:**
- Modify: `backend-bun/src/pipeline/trigger.ts:125`

- [ ] **Step 1: Replace `torrent_name` with empty string**

Edit `backend-bun/src/pipeline/trigger.ts` line 125:

```typescript
// Before:
torrent_name: job.torrentName ?? "",
// After:
torrent_name: "",  // ponytail: not used, file_idx only
```

- [ ] **Step 2: Verify TypeScript types compile**

```bash
cd backend-bun && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add backend-bun/src/pipeline/trigger.ts
git commit -m "fix: send empty torrent_name in trigger dispatch"
```

---

### Task 3: Frontend — Custom magnet sends empty torrent_name

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte:264`

- [ ] **Step 1: Set torrent_name to empty string in addCustomToQueue**

Edit `dashboard/src/pages/SearchPage.svelte` line 264:

```typescript
// Before:
torrent_name: title,
// After:
torrent_name: "",
```

- [ ] **Step 2: Verify Svelte build**

```bash
cd dashboard && bun run build 2>&1 | tail -10
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/SearchPage.svelte
git commit -m "fix: custom magnet sends empty torrent_name"
```

---

### Task 4: CI — Refactor monitor-transmission.sh to index-only

**Files:**
- Modify: `.github/scripts/monitor-transmission.sh` (full rewrite of arg parsing + file selection)

**Changes:**
1. Signature: drop 6th arg `TORRENT_NAME`
2. File selection: remove all `TORRENT_NAME` matching (exact name, partial name)
3. Only match by FILE_IDX (0-based and 1-based)
4. Clean up debug prints

- [ ] **Step 1: Update script signature and usage comment**

Change lines 2-9:

```bash
#!/bin/bash
# monitor-transmission.sh — Run transmission-daemon with progress callbacks
# Usage: monitor-transmission.sh <job_id> <callback_url> <callback_token> <magnet_uri> [file_idx]
JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:-}"
# ponytail: torrent_name removed, file_idx only
```

- [ ] **Step 2: Replace file selection block (lines 88-191)**

The new block:

```bash
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

    # ≤1 confirmed file → single-file torrent, skip selection (download all)
    if [ "$FILE_COUNT" -le 1 ]; then
      echo "  Single-file torrent — downloading entire torrent"
    else
      # FILE_COUNT=0 means metadata not yet loaded — enter matching loop
      # FILE_COUNT>1 means multi-file torrent — enter matching loop
      if [ "$FILE_COUNT" -eq 0 ]; then
        echo "  No file info yet from swarm (0 files reported) — entering file detection loop..."
      fi

      # No search criteria — download all
      if [ -z "$FILE_IDX" ]; then
        echo "  No file_idx provided — downloading entire torrent"
      elif ! [[ "$FILE_IDX" =~ ^[0-9]+$ ]]; then
        echo "  Invalid file_idx ($FILE_IDX) — must be numeric, downloading entire torrent"
      else
        TARGET=""
        for attempt in $(seq 1 24); do
          sleep 5
          FILE_OUT=$(transmission-remote localhost:9092 -t "$TID" --info-files 2>/dev/null || true)

          # Re-check: if file list was 0 but now has actual file lines, detect count
          NEW_FILE_LINES=$(echo "$FILE_OUT" | grep -cE '^[[:space:]]*[0-9]+')
          NEW_COUNT=$(echo "$FILE_OUT" | grep -oP '\(\K[0-9]+(?=\s*files?\))' | head -1)
          if [ "$NEW_COUNT" -eq 1 ] 2>/dev/null || [ "$NEW_FILE_LINES" -eq 1 ] 2>/dev/null; then
            echo "  Single-file detected (file list appeared) — downloading entire torrent"
            TARGET="all"
            break
          fi
          # If no file lines at all yet, continue waiting
          if [ "$NEW_FILE_LINES" -eq 0 ]; then
            continue
          fi

          # Match by file index (try both 0-based and 1-based)
          for IDX in "$FILE_IDX" "$((FILE_IDX + 1))"; do
            MATCH_LINE=$(echo "$FILE_OUT" | grep -E "^[[:space:]]*${IDX}[[:space:]:]" | head -1)
            if [ -n "$MATCH_LINE" ]; then
              TARGET="$IDX"
              echo "  ✓ Matched by index: file $TARGET (FE idx=$FILE_IDX)"
              echo "    $MATCH_LINE"
              break 2
            fi
          done

          # File list appeared but no match yet
          if echo "$FILE_OUT" | grep -qE '^[[:space:]]*[0-9]+'; then
            echo "  File list appeared ($(echo "$FILE_OUT" | grep -cE '^[[:space:]]*[0-9]+') files, no match yet — continuing download until match or timeout)"
          fi
        done

        if [ -n "$TARGET" ] && [ "$TARGET" != "all" ]; then
          echo "  Target file found at index $TARGET, selecting..."
          echo "  Detected file list:"
          echo "$FILE_OUT" | grep -E '^[[:space:]]*[0-9]+' | head -10
          transmission-remote localhost:9092 -t "$TID" --stop > /dev/null 2>&1 || true
          sleep 1
          transmission-remote localhost:9092 -t "$TID" -G all > /dev/null 2>&1 || true
          transmission-remote localhost:9092 -t "$TID" -g "$TARGET" > /dev/null 2>&1 || true
          echo "  Deselected all, selected only file $TARGET"
          transmission-remote localhost:9092 -t "$TID" --start > /dev/null 2>&1 || true
        else
          echo "  WARNING: Could not identify target file — downloading all files"
        fi
      fi  # end check for FILE_IDX
    fi  # end single-file check
  fi  # end else META_READY
```

- [ ] **Step 3: Run validation harness to verify**

```bash
cd .github/scripts && bash validate-transmission.sh
```

Expected: All 4+ scenarios pass (single-file with idx, multi-file with idx, multi-file without idx, single-file without idx).

- [ ] **Step 4: Commit**

```bash
git add .github/scripts/monitor-transmission.sh
git commit -m "fix: monitor-transmission.sh uses file_idx only, drops torrent_name matching"
```

---

### Task 5: CI — Simplify detect step in pipeline YAML

**Files:**
- Modify: `.github/workflows/streamvault-pipeline.yml:112-118` (monitor call)
- Modify: `.github/workflows/streamvault-pipeline.yml:138-180` (detect step)

- [ ] **Step 1: Remove torrent_name arg from monitor.sh call**

Edit lines 112-118 (monitor call block). Change from 6 args to 5:

```yaml
      - name: Download torrent
        if: inputs.skip_download != 'true'
        run: |
          chmod +x .github/scripts/*.sh
          .github/scripts/monitor-transmission.sh \
            "${{ inputs.job_id }}" \
            "${{ inputs.callback_url }}" \
            "${{ inputs.callback_token }}" \
            "${{ inputs.magnet_uri }}" \
            "${{ inputs.file_idx }}"
```

- [ ] **Step 2: Simplify detect step — remove filename matching**

Replace the whole detect step (lines 138-196) with:

```yaml
      - name: Detect source resolution
        id: detect
        shell: bash
        run: |
          INPUT_FILE=$(find ./downloads -type f \
            \( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.avi" -o -iname "*.mov" \) \
            -not -name "*.log" -not -name "*.torrent" \
            -exec ls -1S {} + 2>/dev/null | head -1)

          if [ -z "$INPUT_FILE" ]; then
            echo "❌ Error: No video file found in ./downloads"
            ls -la ./downloads/
            exit 1
          fi
          echo "input_file=$INPUT_FILE" >> "$GITHUB_OUTPUT"
          echo "Input file: $INPUT_FILE"
          echo "File size: $(du -h "$INPUT_FILE" | cut -f1)"

          BASE_NAME=$(basename "$INPUT_FILE")
          if [[ "$BASE_NAME" =~ ([0-9]{3,4})p ]]; then
            SOURCE_HEIGHT="${BASH_REMATCH[1]}"
            echo "⚡ Detected resolution from filename: ${SOURCE_HEIGHT}p"
          else
            SOURCE_HEIGHT=$(ffprobe -v error -select_streams v -show_entries stream=height -of csv=p=n "$INPUT_FILE" 2>/dev/null | sort -nr | head -n1 || echo "0")
            if [ -z "$SOURCE_HEIGHT" ] || [ "$SOURCE_HEIGHT" = "0" ]; then
              echo "⚠ WARNING: Could not determine video height, trying alternative method"
              SOURCE_HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=n:0 "$INPUT_FILE" 2>/dev/null || echo "0")
            fi
          fi
          echo "source_height=$SOURCE_HEIGHT" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Validate YAML syntax**

```bash
bunx --yes yaml-validator .github/workflows/streamvault-pipeline.yml 2>/dev/null || python3 -c "import yaml; yaml.safe_load(open('.github/workflows/streamvault-pipeline.yml')); print('YAML OK')"
```

Expected: YAML OK.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/streamvault-pipeline.yml
git commit -m "fix: detect step uses file_idx only, removed torrent_name matching"
```

---

### Task 6: CI — Update validation harness scenarios

**Files:**
- Modify: `.github/scripts/validate-transmission.sh`

- [ ] **Step 1: Update validation scenarios**

The current scenarios test:
1. Single-file BBB + name → fallback (no seeds)
2. Single-file BBB no name → skip
3. Multi-file Naruto + exact name → file 73
4. Multi-file Naruto + idx → file 73

New scenarios:
1. **Single-file BBB + FILE_IDX=0** → skip selection (single file)
2. **Single-file BBB + no FILE_IDX** → skip selection
3. **Multi-file + FILE_IDX=72 (0-based)** → file 73
4. **Multi-file + FILE_IDX=73 (1-based)** → file 73
5. **Multi-file + no FILE_IDX** → download all
6. **Multi-file + FILE_IDX=999 (out of range)** → download all

- [ ] **Step 2: Run validation harness**

```bash
bash .github/scripts/validate-transmission.sh
```

Expected: All 6 scenarios pass.

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/validate-transmission.sh
git commit -m "fix: update validation harness for index-only file selection"
```

---

### Task 7: Notify user via Telegram

- [ ] **Step 1: Send Telegram notification that spec and plan are ready**

Use the Telegram reply tool with message:
"Spec dan implementation plan sudah selesai. 6 task:
1. Backend: behaviorHints.fileIdx prioritization
2. Backend: trigger.ts empty torrent_name
3. Frontend: custom magnet empty torrent_name
4. CI: monitor.sh index-only refactor
5. CI: detect step simplification
6. CI: validation harness update

Review docs/superpowers/specs/2026-06-22-file-selection-by-index.md
Plan at docs/superpowers/plans/2026-06-22-file-selection-by-index.md

Trigger eksekusi?"
