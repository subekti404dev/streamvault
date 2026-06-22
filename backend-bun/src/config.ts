export interface Config {
  databaseUrl: string;
  authSecret: string;
  publicBaseUrl: string;
  ghToken?: string;
  ghRepo?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  discordChannelIds?: string;
  telegramBotToken?: string;
  telegramChannelId?: string;
  torrentioBaseUrl?: string;
  dashboardDir: string;
}

export function loadConfig(): Config {
  return {
    databaseUrl: process.env.STREAMVAULT_DATABASE_URL || "sqlite:data/streamvault.db?mode=rwc",
    authSecret: process.env.STREAMVAULT_AUTH_SECRET || "streamvault-dev-secret",
    publicBaseUrl: process.env.STREAMVAULT_PUBLIC_BASE_URL || "http://localhost:8080",
    ghToken: process.env.STREAMVAULT_GH_TOKEN,
    ghRepo: process.env.STREAMVAULT_GH_REPO,
    discordBotToken: process.env.STREAMVAULT_DISCORD_BOT_TOKEN,
    discordChannelId: process.env.STREAMVAULT_DISCORD_CHANNEL_ID,
    discordChannelIds: process.env.STREAMVAULT_DISCORD_CHANNEL_IDS,
    telegramBotToken: process.env.STREAMVAULT_TELEGRAM_BOT_TOKEN,
    telegramChannelId: process.env.STREAMVAULT_TELEGRAM_CHANNEL_ID,
    torrentioBaseUrl: process.env.STREAMVAULT_TORRENTIO_BASE_URL,
    dashboardDir: process.env.STREAMVAULT_DASHBOARD_DIR || "dashboard/dist",
  };
}
