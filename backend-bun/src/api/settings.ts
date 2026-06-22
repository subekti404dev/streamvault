import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest, internal } from "../error";
import * as queries from "../db/queries";

const SETTING_KEYS = [
  "gh_token", "gh_repo",
  "discord_bot_token", "discord_channel_id", "discord_channel_ids",
  "telegram_bot_token", "telegram_channel_id",
  "notifications_enabled",
  "torrentio_base_url",
  "public_base_url",
  "stremio_addon_id", "stremio_addon_name", "stremio_metadata_url",
] as const;

const SENSITIVE_KEYS: Record<string, true> = { gh_token: true, discord_bot_token: true, telegram_bot_token: true, auth_secret: true };

// ponytail: single mask function, matches Rust behavior exactly
function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return token.slice(0, 4) + "...";
}

function configValue(config: AppBindings["Variables"]["config"], key: string): string | undefined {
  switch (key) {
    case "gh_token": return config.ghToken;
    case "gh_repo": return config.ghRepo;
    case "discord_bot_token": return config.discordBotToken;
    case "discord_channel_id": return config.discordChannelId;
    case "discord_channel_ids": return config.discordChannelIds;
    case "telegram_bot_token": return config.telegramBotToken;
    case "telegram_channel_id": return config.telegramChannelId;
    case "torrentio_base_url": return config.torrentioBaseUrl;
    case "public_base_url": return config.publicBaseUrl;
    default: return undefined;
  }
}

export async function getSettings(c: Context<AppBindings>) {
  const { config, db } = c.var;
  const rows = queries.getAllSettings(db);
  const dbMap: Record<string, string> = {};
  for (const row of rows) {
    dbMap[row.key] = row.value ?? "";
  }

  const result: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const value = dbMap[key] || configValue(config, key) || "";
    result[key] = SENSITIVE_KEYS[key] ? maskToken(value) : value;
  }

  return c.json(result);
}

export async function updateSettings(c: Context<AppBindings>) {
  const { config, db } = c.var;
  const body = await c.req.json<Record<string, string>>();

  // Fetch existing DB values for sensitive keys that might be masked
  const existingRows = queries.getAllSettings(db);
  const existingMap: Record<string, string> = {};
  for (const row of existingRows) {
    existingMap[row.key] = row.value ?? "";
  }

  for (const [key, value] of Object.entries(body)) {
    // ponytail: detect masked values — frontend receives masked token from
    // getSettings, user saves without editing → masked value overwrites real token.
    // If value matches mask of stored value, keep stored value.
    let finalValue = value;
    if (SENSITIVE_KEYS[key]) {
      const stored = existingMap[key] || configValue(config, key) || "";
      if (stored && maskToken(stored) === value) {
        finalValue = stored;
      }
    }
    queries.upsertSetting(db, key, finalValue);
    // Reload in-memory config
    switch (key) {
      case "gh_token": config.ghToken = finalValue; break;
      case "gh_repo": config.ghRepo = finalValue; break;
      case "discord_bot_token": config.discordBotToken = finalValue; break;
      case "discord_channel_id": config.discordChannelId = finalValue; break;
      case "discord_channel_ids": config.discordChannelIds = finalValue; break;
      case "telegram_bot_token": config.telegramBotToken = finalValue; break;
      case "telegram_channel_id": config.telegramChannelId = finalValue; break;
      case "torrentio_base_url": config.torrentioBaseUrl = finalValue; break;
      case "public_base_url": config.publicBaseUrl = finalValue; break;
      case "auth_secret": config.authSecret = finalValue; break;
    }
  }
  return c.json({ status: "saved" });
}

export async function testNotification(c: Context<AppBindings>) {
  const { config, db } = c.var;

  const botToken = queries.getSetting(db, "telegram_bot_token") || config.telegramBotToken || "";
  if (!botToken) throw badRequest("Telegram bot token not configured");

  const channelId = queries.getSetting(db, "telegram_channel_id") || config.telegramChannelId || "";
  if (!channelId) throw badRequest("Telegram channel ID not configured");

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text: "Test notification from StreamVault",
      parse_mode: "HTML",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("[settings] Telegram test failed:", resp.status, text);
    return c.json({ error: `Telegram API error (${resp.status}): ${text}` }, 502);
  }

  return c.json({ ok: true });
}
