#!/bin/bash
# callback.sh — Send progress/status callback to StreamVault backend
# Usage: callback.sh <job_id> <endpoint> <payload_json>

set -e

JOB_ID="${1:?Missing job_id}"
ENDPOINT="${2:?Missing endpoint}"
PAYLOAD="${3:?Missing payload}"

curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Callback-Token: $CALLBACK_TOKEN" \
  -d "$PAYLOAD" \
  "${CALLBACK_URL}/api/v1/jobs/${JOB_ID}/${ENDPOINT}" || echo "Callback to ${ENDPOINT} failed" >&2
