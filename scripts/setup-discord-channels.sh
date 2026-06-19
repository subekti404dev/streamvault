#!/bin/bash
# setup-discord-channels.sh — Create 5 Discord upload channels + configure permissions
#
# Prerequisites:
#   1. Bot token with permissions: Manage Channels, Send Messages, Attach Files, Read Messages
#   2. Bot must be in the server (guild)
#   3. jq installed (apt install jq / brew install jq)
#
# Usage:
#   ./scripts/setup-discord-channels.sh
#
# Environment:
#   DISCORD_BOT_TOKEN - (required) your bot token
#   GUILD_ID          - (required) Discord server/guild ID
#   CHANNEL_PREFIX    - (optional) channel name prefix, default "sv"
#   CHANNEL_COUNT     - (optional) number of channels, default 5
#   BOT_USER_ID       - (optional) bot user ID, auto-detected if omitted

set -uo pipefail
# NOTE: no 'set -e' — we handle errors manually

PREFIX="${CHANNEL_PREFIX:-sv}"
COUNT="${CHANNEL_COUNT:-5}"
API="https://discord.com/api/v10"

# ── Safely call Discord API ──
# Returns: response body (prints to stdout)
discord_api() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  local headers=(-H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json")

  if [ -n "$data" ]; then
    curl -s -X "$method" "${headers[@]}" -d "$data" "$url"
  else
    curl -s -X "$method" "${headers[@]}" "$url"
  fi
}

discord_upload() {
  local channel_id="$1"
  local file="$2"
  local content="$3"
  curl -s -X POST \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -F "file=@$file" \
    -F "content=$content" \
    "$API/channels/$channel_id/messages"
}

# ── Input ──

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  read -r -s -p "Discord bot token: " DISCORD_BOT_TOKEN
  echo
fi

if [ -z "${GUILD_ID:-}" ]; then
  read -r -p "Discord server/guild ID: " GUILD_ID
fi

# ── Validate token ──

echo
echo "=== Validating Discord bot token ==="

ME_RESPONSE=$(discord_api GET "$API/users/@me")
ME_ID=$(echo "$ME_RESPONSE" | jq -r '.id // empty')
ME_BOT=$(echo "$ME_RESPONSE" | jq -r '.bot // empty')

if [ -z "$ME_ID" ] || [ "$ME_BOT" != "true" ]; then
  ERR=$(echo "$ME_RESPONSE" | jq -r '.message // "Invalid token (empty response)"')
  echo "❌ Token invalid: $ERR"
  echo "   Reset token: https://discord.com/developers/applications"
  echo "   Then retry with: export DISCORD_BOT_TOKEN=\"new_token\""
  exit 1
fi

echo "✓ Token valid — bot ID: $ME_ID"

# ── Validate guild ──

echo
echo "=== Validating guild/server ID ==="

GUILD_RESPONSE=$(discord_api GET "$API/guilds/$GUILD_ID")
GUILD_ERROR=$(echo "$GUILD_RESPONSE" | jq -r '.message // empty')
GUILD_NAME=$(echo "$GUILD_RESPONSE" | jq -r '.name // empty')

if [ -z "$GUILD_NAME" ]; then
  echo "❌ Guild invalid: ${GUILD_ERROR:-Not found}"
  echo "   Check:"
  echo "     - Bot invited to the server?"
  echo "     - GUILD_ID correct? (right-click server name → Copy ID)"
  echo "     - Developer Mode ON in Discord Settings → Advanced"
  exit 1
fi

echo "✓ Guild: $GUILD_NAME (ID: $GUILD_ID)"

# ── Auto-detect bot user ID (from token validation result) ──

if [ -z "${BOT_USER_ID:-}" ]; then
  echo
  echo "=== Auto-detecting bot user ID ==="
  BOT_USER_ID="$ME_ID"
  echo "✓ Bot user ID: $BOT_USER_ID"
fi
# ── Create channels ──

echo
echo "=== Creating $COUNT channels (prefix: $PREFIX) ==="

CHANNEL_IDS=()

for i in $(seq 1 "$COUNT"); do
  NAME="${PREFIX}-${i}"
  echo -n "  Creating #$NAME ... "

  RESPONSE=$(discord_api POST "$API/guilds/$GUILD_ID/channels" "{\"name\":\"$NAME\",\"type\":0}")
  CHANNEL_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
  CHANNEL_NAME=$(echo "$RESPONSE" | jq -r '.name // empty')

  if [ -z "$CHANNEL_ID" ]; then
    ERROR=$(echo "$RESPONSE" | jq -r '.message // "Unknown"')
    echo "❌ $ERROR"
    echo "   Check bot has 'Manage Channels' permission"
    exit 1
  fi

  echo "✓ #$CHANNEL_NAME (id: $CHANNEL_ID)"
  CHANNEL_IDS+=("$CHANNEL_ID")
done

# ── Set permissions ──
# 2048   = Send Messages (deny @everyone)
# 68608  = Send Messages + Attach Files + Read Messages (allow bot)

echo
echo "=== Setting permissions ==="

for CHANNEL_ID in "${CHANNEL_IDS[@]}"; do
  echo -n "  $CHANNEL_ID: deny @everyone ... "
  R=$(discord_api PUT "$API/channels/$CHANNEL_ID/permissions/$GUILD_ID" \
    "{\"deny\":\"2048\",\"type\":0,\"id\":\"$GUILD_ID\"}")
  ERR=$(echo "$R" | jq -r '.message // empty')
  if [ -n "$ERR" ]; then echo "⚠ $ERR"; else echo "✓"; fi

  echo -n "  $CHANNEL_ID: allow bot upload ... "
  R=$(discord_api PUT "$API/channels/$CHANNEL_ID/permissions/$BOT_USER_ID" \
    "{\"allow\":\"68608\",\"type\":1,\"id\":\"$BOT_USER_ID\"}")
  ERR=$(echo "$R" | jq -r '.message // empty')
  if [ -n "$ERR" ]; then echo "⚠ $ERR"; else echo "✓"; fi
done

# ── Verify upload test ──

echo
echo "=== Testing upload to each channel ==="

ALL_OK=true
for CHANNEL_ID in "${CHANNEL_IDS[@]}"; do
  echo -n "  $CHANNEL_ID ... "
  RESPONSE=$(discord_upload "$CHANNEL_ID" /dev/null "streamvault-test-$CHANNEL_ID")
  MSG_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

  if [ -n "$MSG_ID" ]; then
    echo "✓"
    # Cleanup
    discord_api DELETE "$API/channels/$CHANNEL_ID/messages/$MSG_ID" > /dev/null
  else
    ERR=$(echo "$RESPONSE" | jq -r '.message // "send/attach blocked"')
    echo "❌ $ERR"
    ALL_OK=false
  fi
done

# ── Output ──

CSV=""
for ID in "${CHANNEL_IDS[@]}"; do
  if [ -n "$CSV" ]; then CSV+=","; fi
  CSV+="$ID"
done

echo
echo "═══════════════════════════════════════════════════"
echo "  ✅  Done!"
echo
echo "  Channel IDs (paste to dashboard Settings):"
echo
echo "  discord_channel_ids:"
echo "  $CSV"
echo
echo "  Single env (fallback):"
echo "  DISCORD_CHANNEL_ID=${CHANNEL_IDS[0]}"
echo
echo "  Dashboard → Settings → discord_channel_ids"
echo "═══════════════════════════════════════════════════"

if [ "$ALL_OK" != true ]; then
  echo
  echo "⚠ Some upload tests failed — check bot permissions:"
  echo "   ✅ Send Messages"
  echo "   ✅ Attach Files"
  echo "   ✅ View Channels / Read Messages"
  exit 1
fi
