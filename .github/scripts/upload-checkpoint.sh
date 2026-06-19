#!/bin/bash
# upload-checkpoint.sh — Upload artifact, resolve download URL, callback to backend
# Usage: upload-checkpoint.sh <job_id> <checkpoint_name> <artifact_path>
set -uo pipefail

JOB_ID="${1:?Missing job_id}"
CHECKPOINT="${2:?Missing checkpoint (download|transcode)}"
ARTIFACT_PATH="${3:?Missing artifact path}"
ARTIFACT_NAME="checkpoint-${CHECKPOINT}-${JOB_ID}"

# Wait a moment for the upload-artifact action to finish registering
sleep 5

# Resolve artifact ID and download URL from the current run
ARTIFACT_INFO=$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts" \
  --jq ".artifacts[] | select(.name == \"$ARTIFACT_NAME\") | {id, url: .archive_download_url}")

if [ -z "$ARTIFACT_INFO" ]; then
  echo "WARNING: Could not resolve artifact $ARTIFACT_NAME yet, retrying in 10s..." >&2
  sleep 10
  ARTIFACT_INFO=$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts" \
    --jq ".artifacts[] | select(.name == \"$ARTIFACT_NAME\") | {id, url: .archive_download_url}")
fi

if [ -z "$ARTIFACT_INFO" ]; then
  echo "WARNING: Failed to resolve artifact $ARTIFACT_NAME, checkpoint saved without file URL" >&2
  # Still callback with just artifact_id
  .github/scripts/callback.sh "$JOB_ID" "checkpoint" \
    "{\"checkpoint\":\"$CHECKPOINT\",\"artifact_id\":\"$ARTIFACT_NAME\"}"
  exit 0
fi

FILE_URL=$(echo "$ARTIFACT_INFO" | jq -r '.url')

echo "Resolved artifact $ARTIFACT_NAME url=$FILE_URL"

# Callback to backend with file_url and artifact_id
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/callback.sh" "$JOB_ID" "checkpoint" \
  "$(jq -n --arg cp "$CHECKPOINT" --arg id "$ARTIFACT_NAME" --arg url "$FILE_URL" \
    '{checkpoint: $cp, artifact_id: $id, file_url: $url}')"

echo "Checkpoint $CHECKPOINT saved with file URL"
