import type { Context } from "hono";
import type { DrizzleDB } from "../db/index";
import type { Config } from "../config";
import { getSetting } from "../db/queries";

// ── Types ──

export interface TelegramEvent {
  type:
    | "JobQueued"
    | "JobStarted"
    | "CheckpointSaved"
    | "JobCompleted"
    | "JobFailed";
  title: string;
  phase?: string;
  error?: string;
  details?: string;
}

// ── Globals for scheduler path (no request context) ──

let _db: DrizzleDB | null = null;
let _config: Config | null = null;

export function setNotificationGlobals(db: DrizzleDB, config: Config): void {
  _db = db;
  _config = config;
}

// ── Message formatting ──

export function formatMessage(event: TelegramEvent): string {
  switch (event.type) {
    case "JobQueued":
      return `🎬 <b>Added to queue:</b> ${event.title}`;
    case "JobStarted":
      return `⚙️ <b>Processing started:</b> ${event.title}`;
    case "CheckpointSaved":
      return `💾 <b>Checkpoint saved:</b> ${event.title} — ${event.phase}`;
    case "JobCompleted":
      return [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "✅ <b>StreamVault - Download Complete</b>",
        "",
        `🎬 ${event.title}`,
        event.details ?? "",
      ].join("\n");
    case "JobFailed":
      return `❌ <b>Failed:</b> ${event.title} at ${event.phase} — ${event.error}`;
  }
}

// ── Send ──

export async function sendNotification(
  c: Context<any> | null,
  event: TelegramEvent,
): Promise<void> {
  const db = c?.var?.db ?? _db;
  const config = c?.var?.config ?? _config;
  if (!db || !config) return;

  const enabled = getSetting(db, "notifications_enabled");
  if (enabled !== "true") return;

  const botToken =
    getSetting(db, "telegram_bot_token") || config.telegramBotToken;
  const channelId =
    getSetting(db, "telegram_channel_id") || config.telegramChannelId;
  if (!botToken || !channelId) return;

  const text = formatMessage(event);

  // ponytail: fire-and-forget, .catch swallows network errors silently
  fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text,
        parse_mode: "HTML",
      }),
    },
  ).catch((e) => console.error("[telegram] notification failed:", e));
}
