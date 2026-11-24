import path from 'node:path';

import express from 'express';

import { validateRequestPayload } from './requests.js';

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * HTTP-часть: публичное API для сайта + раздача index.html при локальном запуске.
 * Сайт на GitHub Pages обращается только к /api/*, поэтому CORS открыт
 * для POST /api/requests (форма) и GET /api/schedule (расписание).
 */
export function createHttpApp({ config, scheduleService, requestService, logger, notifyNewRequest }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json({ limit: config.requestBodyLimit }));

  const allowAllOrigins = config.allowedOrigins.includes('*');

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = allowAllOrigins || (origin && config.allowedOrigins.includes(origin));
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowAllOrigins ? '*' : origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ─── Ограничение частоты заявок ─────────────────────────────────────────────

  const hits = new Map();
  const limiterTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((time) => now - time < config.rateLimit.windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }, Math.max(60_000, config.rateLimit.windowMs));
  limiterTimer.unref?.();

  function rateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const fresh = (hits.get(key) ?? []).filter((time) => now - time < config.rateLimit.windowMs);
    if (fresh.length >= config.rateLimit.max) {
      const retryAfter = Math.ceil((config.rateLimit.windowMs - (now - fresh[0])) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      res.status(429).json({
        ok: false,
        error: 'Слишком много заявок с этого адреса. Попробуйте позже или напишите в Telegram.',
      });
      return;
    }
    fresh.push(now);
    hits.set(key, fresh);
    next();
  }

  // ─── API ────────────────────────────────────────────────────────────────────

  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      const [{ counts }, totals] = await Promise.all([scheduleService.stats(), requestService.totals()]);
      res.json({
        ok: true,
        uptime: Math.round(process.uptime()),
        events: counts,
        requests: totals,
      });
    }),
  );

  app.get(
    '/api/schedule',
    asyncHandler(async (req, res) => {
      res.json(await scheduleService.getSchedule());
    }),
  );

  app.post(
    '/api/requests',
    rateLimit,
    asyncHandler(async (req, res) => {
      const body = req.body ?? {};

      // Ловушка для ботов: поле скрыто от людей, поэтому заполненное поле
      // означает автоматический спам. Отвечаем «успехом», но ничего не сохраняем.
      if (String(body.website ?? '').trim()) {
        logger.debug('Заявка отброшена как спам (honeypot).');
        res.status(201).json({ ok: true });
        return;
      }

      const validation = validateRequestPayload(body);
      if (!validation.ok) {
        res.status(400).json({
          ok: false,
          error: 'Проверьте поля формы.',
          fields: validation.errors,
        });
        return;
      }

      const request = await requestService.create(validation.value, { source: 'site' });
      res.status(201).json({ ok: true, id: request.id });

      Promise.resolve(notifyNewRequest?.(request)).catch((error) => {
        logger.warn(`Не удалось уведомить о заявке #${request.id}:`, error?.message ?? error);
      });
    }),
  );

  // ─── Страница для локального просмотра ──────────────────────────────────────

  const staticFiles = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/config.js', 'config.js'],
    ['/schedule.json', 'schedule.json'],
  ]);

  app.get([...staticFiles.keys()], (req, res, next) => {
    const file = staticFiles.get(req.path);
    if (!file) {
      next();
      return;
    }
    res.sendFile(path.join(config.root, file), (error) => {
      if (error) next(error);
    });
  });

  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: 'Не найдено' });
      return;
    }
    res.status(404).type('text/plain').send('404 — страница не найдена');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: 'Слишком большой запрос.' });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ ok: false, error: 'Некорректный JSON.' });
      return;
    }
    logger.error('Ошибка HTTP:', error?.message ?? error);
    if (error?.code === 'ENOENT') {
      res.status(404).type('text/plain').send('Файл не найден');
      return;
    }
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера.' });
  });

  app.locals.limiterTimer = limiterTimer;
  return app;
}
