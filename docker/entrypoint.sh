#!/bin/sh
set -e

# Create data directory if needed
mkdir -p /data

export STREAMVAULT_DATABASE_URL="${STREAMVAULT_DATABASE_URL:-sqlite:/data/streamvault.db?mode=rwc}"
export STREAMVAULT_DASHBOARD_DIR="${STREAMVAULT_DASHBOARD_DIR:-/app/dashboard}"

echo "Starting StreamVault..."
exec ./streamvault
