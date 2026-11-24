import path from 'node:path';

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIdList(raw) {
  return String(raw ?? '')
    .split(/[,\s;]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function parseOriginList(raw) {
  return String(raw ?? '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Читает настройки из переменных окружения.
 * Все значения необязательны, кроме BOT_TOKEN (без него бот не запускается).
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  return {
    root: cwd,
    dataDir: path.resolve(cwd, env.DATA_DIR?.trim() || 'data'),
    seedSchedulePath: path.resolve(cwd, env.SEED_SCHEDULE?.trim() || 'schedule.json'),
    siteUrl: (env.SITE_URL?.trim() || 'https://regressional.ru').replace(/\/+$/, ''),
    botToken: (env.BOT_TOKEN || '').trim(),
    adminIds: parseIdList(env.ADMIN_IDS),
    port: toInt(env.PORT, 8080),
    host: env.HOST?.trim() || '0.0.0.0',
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
    allowedOrigins: parseOriginList(env.ALLOWED_ORIGINS),
    timezone: env.TZ_NAME?.trim() || 'Europe/Moscow',
    telegramApiRoot: (env.TELEGRAM_API_ROOT?.trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
    rateLimit: {
      max: toInt(env.RATE_LIMIT_MAX, 5),
      windowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    },
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    requestBodyLimit: env.REQUEST_BODY_LIMIT?.trim() || '16kb',
  };
}
