import { Bot, webhookCallback } from 'grammy';

import { createBotCore } from '../src/botCore.js';
import { createLogger } from '../src/logger.js';
import { validateRequestPayload } from '../src/requests.js';
import { normalizeSchedule } from '../src/schedule.js';
import { createRequestService, createScheduleService } from '../src/services.js';
import { configFromEnv } from './config.js';
import { D1PendingStore } from './pendingStore.js';
import { D1JsonStore } from './store.js';
import seedSchedule from '../schedule.json' with { type: 'json' };

const JSON_TYPE = 'application/json; charset=utf-8';

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request, config) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  const origin = request.headers.get('Origin');

  if (config.allowedOrigins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && config.allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function statusPage(config, counts, totals) {
  const site = config.siteUrl.replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>allareg bot</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#202720}
code{background:#f2efe7;padding:2px 6px}h1{font-size:1.6rem}</style></head>
<body>
<h1>Сервер бота работает</h1>
<p>Сайт: <a href="${site}">${site}</a></p>
<p>Мероприятий: очно — ${counts.onsite}, онлайн — ${counts.online}. Заявок: ${totals.total}, новых: ${totals.new}.</p>
<p>API: <code>/api/schedule</code>, <code>/api/requests</code>, <code>/api/health</code>.</p>
</body></html>`;
}

/**
 * Приложение для Cloudflare Workers: то же API и тот же бот, что в Node-версии,
 * но обновления приходят вебхуком, а данные лежат в D1.
 */
export function createWorkerApp(env, options = {}) {
  if (!env?.DB) {
    throw new Error('Не настроена база D1: добавьте binding DB в wrangler.toml и примените worker/schema.sql');
  }

  const config = configFromEnv(env);
  const logger = options.logger ?? createLogger(config.logLevel);

  const scheduleStore = new D1JsonStore(env.DB, 'schedule');
  const requestsStore = new D1JsonStore(env.DB, 'requests');
  const scheduleService = createScheduleService({ store: scheduleStore, logger });
  const requestService = createRequestService({ store: requestsStore, logger });

  const bot = config.botToken
    ? new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } })
    : null;

  const core = bot
    ? createBotCore({
        bot,
        config,
        logger,
        scheduleService,
        requestService,
        pendingStore: new D1PendingStore(env.DB),
      })
    : null;

  const webhook = bot
    ? webhookCallback(bot, 'cloudflare-mod', {
        secretToken: config.webhookSecret || undefined,
        timeoutMilliseconds: 25_000,
      })
    : null;

  let seedPromise = null;
  function ensureSeeded() {
    if (!seedPromise) {
      seedPromise = (async () => {
        if ((await scheduleStore.read()) === null) {
          await scheduleStore.write(normalizeSchedule(seedSchedule));
          logger.info('Расписание засеяно из schedule.json');
        }
      })().catch((error) => {
        seedPromise = null;
        throw error;
      });
    }
    return seedPromise;
  }

  async function checkRateLimit(request, ctx) {
    const ip =
      request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const now = Date.now();
    const { max, windowMs } = config.rateLimit;
    const windowStart = Math.floor(now / windowMs) * windowMs;

    await env.DB.prepare(
      `INSERT INTO rate_limit (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(ip, window_start) DO UPDATE SET count = count + 1`,
    )
      .bind(ip, windowStart)
      .run();

    const row = await env.DB.prepare('SELECT count FROM rate_limit WHERE ip = ? AND window_start = ?')
      .bind(ip, windowStart)
      .first();
    const count = Number(row?.count ?? 1);

    // Иногда подчищаем старые окна, чтобы таблица не росла.
    if (Math.random() < 0.05) {
      const cleanup = env.DB.prepare('DELETE FROM rate_limit WHERE window_start < ?')
        .bind(windowStart - windowMs)
        .run()
        .catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(cleanup);
    }

    return {
      allowed: count <= max,
      retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  }

  async function handleRequestPost(request, cors, ctx) {    const limit = await checkRateLimit(request, ctx);
    if (!limit.allowed) {
      return json(
        { ok: false, error: 'Слишком много заявок с этого адреса. Попробуйте позже или напишите в Telegram.' },
        429,
        { ...cors, 'Retry-After': String(limit.retryAfter) },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Некорректный JSON.' }, 400, cors);
    }

    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: 'Ожидается JSON-объект.' }, 400, cors);
    }

    // Ловушка для ботов: скрытое поле заполняют только автоматические отправители.
    if (String(body.website ?? '').trim()) {
      return json({ ok: true }, 201, cors);
    }

    const validation = validateRequestPayload(body);
    if (!validation.ok) {
      return json({ ok: false, error: 'Проверьте поля формы.', fields: validation.errors }, 400, cors);
    }

    const record = await requestService.create(validation.value, { source: 'site' });

    if (core) {
      const notify = core.notifyNewRequest(record).catch((error) => {
        logger.warn(`Не удалось уведомить о заявке #${record.id}:`, error?.message ?? error);
      });
      if (ctx?.waitUntil) ctx.waitUntil(notify);
      else await notify;
    } else {
      logger.warn(`Заявка #${record.id} сохранена, но бот не настроен (нет BOT_TOKEN).`);
    }

    return json({ ok: true, id: record.id }, 201, cors);
  }

  function setupAuthorized(request) {
    const header = request.headers.get('X-Setup-Token');
    return Boolean(config.webhookSecret && header && header === config.webhookSecret);
  }

  async function telegramCall(method, payload = {}) {
    const response = await fetch(`${config.telegramApiRoot}/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  async function handle(request, envArg, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, config);

    if (request.method === 'OPTIONS' && path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (path === '/api/health' && request.method === 'GET') {
        await ensureSeeded();
        const [{ counts }, totals] = await Promise.all([scheduleService.stats(), requestService.totals()]);
        return json({ ok: true, runtime: 'cloudflare-worker', events: counts, requests: totals }, 200, cors);
      }

      if (path === '/api/schedule' && request.method === 'GET') {
        await ensureSeeded();
        return json(await scheduleService.getSchedule(), 200, cors);
      }

      if (path === '/api/setup' && (request.method === 'POST' || request.method === 'DELETE')) {
        if (!config.botToken) {
          return json({ ok: false, error: 'BOT_TOKEN не задан' }, 503, cors);
        }
        if (!setupAuthorized(request)) {
          return json({ ok: false, error: 'Нет доступа' }, 403, cors);
        }

        if (request.method === 'DELETE') {
          const result = await telegramCall('deleteWebhook', { drop_pending_updates: false });
          return json(
            { ok: Boolean(result.data.ok), description: result.data.description ?? null },
            result.data.ok ? 200 : 502,
            cors,
          );
        }

        // Вебхук ставится из самого воркера: это работает, даже если
        // из вашей сети api.telegram.org недоступен.
        const origin = new URL(request.url).origin;
        const webhookUrl = `${origin}/telegram/${config.webhookSecret}`;
        const result = await telegramCall('setWebhook', {
          url: webhookUrl,
          secret_token: config.webhookSecret,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false,
        });
        return json(
          { ok: Boolean(result.data.ok), description: result.data.description ?? null, url: webhookUrl },
          result.data.ok ? 200 : 502,
          cors,
        );
      }

      if (path === '/api/webhook-info' && request.method === 'GET') {
        if (!config.botToken) {
          return json({ ok: false, error: 'BOT_TOKEN не задан' }, 503, cors);
        }
        if (!setupAuthorized(request)) {
          return json({ ok: false, error: 'Нет доступа' }, 403, cors);
        }
        const info = await telegramCall('getWebhookInfo', {});
        const me = await telegramCall('getMe', {});
        return json(
          {
            ok: Boolean(info.data.ok),
            info: info.data.result ?? null,
            bot: me.data.result ?? null,
            description: info.data.description ?? null,
          },
          info.data.ok ? 200 : 502,
          cors,
        );
      }

      if (path === '/api/requests' && request.method === 'POST') {
        await ensureSeeded();
        return await handleRequestPost(request, cors, ctx);
      }

      if (path === '/telegram' || path.startsWith('/telegram/')) {
        if (!webhook) {
          return new Response('Бот не настроен: отсутствует BOT_TOKEN', { status: 503 });
        }
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed', { status: 405 });
        }
        if (config.webhookSecret) {
          const secret = path.split('/').filter(Boolean)[1];
          if (secret !== config.webhookSecret) {
            return new Response('Not found', { status: 404 });
          }
        }
        await ensureSeeded();
        return await webhook(request, envArg, ctx);
      }

      if (path === '/' && request.method === 'GET') {
        await ensureSeeded();
        const [{ counts }, totals] = await Promise.all([scheduleService.stats(), requestService.totals()]);
        return new Response(statusPage(config, counts, totals), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (path.startsWith('/api/')) {
        return json({ ok: false, error: 'Не найдено' }, 404, cors);
      }
      return new Response('404 — не найдено', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } catch (error) {
      logger.error('Ошибка обработки запроса:', error?.message ?? error);
      return json({ ok: false, error: 'Внутренняя ошибка сервера.' }, 500, cors);
    }
  }

  return {
    fetch: handle,
    config,
    bot,
    scheduleService,
    requestService,
    ensureSeeded,
  };
}
