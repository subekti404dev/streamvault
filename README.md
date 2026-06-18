# StreamVault

Personal media streaming pipeline — a Stremio addon that downloads, transcodes, and streams movies/series via Discord storage.

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your secrets (at minimum STREAMVAULT_AUTH_SECRET and STREAMVAULT_PUBLIC_BASE_URL)

# 2. Start with Docker
docker compose up -d

# 3. Open dashboard
open http://localhost:8080
```

## Architecture

```
User → Svelte Dashboard → Rust API (Axum) → GitHub Actions → Discord CDN → Stremio
```

- **Backend**: Rust (Axum) with SQLite, serves the Stremio addon, HLS proxy, and dashboard API
- **Frontend**: Svelte 5 with glassmorphism UI, SSE real-time updates
- **Pipeline**: GitHub Actions handles download (aria2c), transcode (ffmpeg → HLS), and upload to Discord
- **Storage**: HLS chunks stored permanently on Discord CDN, proxied through the backend

## Configuration

Set via environment variables or the dashboard Settings page:

| Variable | Required | Description |
|---|---|---|
| `STREAMVAULT_AUTH_SECRET` | ✅ | Dashboard login token |
| `STREAMVAULT_PUBLIC_BASE_URL` | ✅ | Public URL (for Stremio manifest) |
| `STREAMVAULT_GH_TOKEN` | — | GitHub PAT for triggering workflows |
| `STREAMVAULT_GH_REPO` | — | GitHub repo `owner/name` |
| `STREAMVAULT_DISCORD_BOT_TOKEN` | — | Discord bot token for HLS uploads |
| `STREAMVAULT_DISCORD_CHANNEL_ID` | — | Discord channel for uploads |
| `STREAMVAULT_TELEGRAM_BOT_TOKEN` | — | Telegram bot for notifications |
| `STREAMVAULT_TELEGRAM_CHANNEL_ID` | — | Telegram channel for alerts |
| `STREAMVAULT_TORRENTIO_BASE_URL` | — | Torrentio proxy URL |

## Development

```bash
# Terminal 1: Backend
cd backend && cargo run

# Terminal 2: Frontend
cd dashboard && npm run dev
```

The Vite dev server proxies API requests to the backend on port 8080.

## Stremio Addon

After deployment, install the addon in Stremio by opening:
```
https://your-server.com/manifest.json
```

## Pipeline Flow

1. **Search** — Enter IMDB ID → fetch metadata + torrents via Torrentio
2. **Queue** — Select a torrent → job enters FIFO queue
3. **Download** — GHA downloads via aria2c, saves checkpoint artifact
4. **Transcode** — ffmpeg converts to HLS (H.264 + AAC, 6s segments)
5. **Upload** — Each segment uploaded to Discord channel
6. **Stream** — Stremio fetches HLS via the backend proxy

Checkpoint-based retry allows resuming from download, transcode, or upload phase.

## Deployment

```bash
docker compose up -d
```

Required secrets for production:
- `STREAMVAULT_AUTH_SECRET` — strong random token
- `STREAMVAULT_PUBLIC_BASE_URL` — full URL including protocol
- GitHub PAT with `repo` and `workflow` scopes
- Discord bot token with file upload permissions
- (Optional) Telegram bot token for notifications

