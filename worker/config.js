function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIds(raw) {
  return String(raw ?? '')
    .split(/[,\s;]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function parseOrigins(raw) {
  return String(raw ?? '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Настройки воркера берутся из переменных и секретов Cloudflare
 * (wrangler.toml + wrangler secret put).
 */
export function configFromEnv(env = {}) {
  return {
    siteUrl: (env.SITE_URL || 'https://regressional.ru').trim().replace(/\/+$/, ''),
    botToken: (env.BOT_TOKEN || '').trim(),
    adminIds: parseIds(env.ADMIN_IDS),
    timezone: (env.TZ_NAME || 'Europe/Moscow').trim(),
    telegramApiRoot: (env.TELEGRAM_API_ROOT || 'https://api.telegram.org').trim().replace(/\/+$/, ''),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    rateLimit: {
      max: toInt(env.RATE_LIMIT_MAX, 5),
      windowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    },
    webhookSecret: (env.WEBHOOK_SECRET || '').trim(),
    logLevel: (env.LOG_LEVEL || 'info').trim(),
  };
}
