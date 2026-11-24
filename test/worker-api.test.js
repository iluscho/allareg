import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerApp } from '../worker/app.js';
import { createD1Shim } from './d1Shim.js';
import { startMockTelegram, textUpdate } from './mockTelegram.js';

const BASE = 'https://allareg.test';
const SECRET = 'webhook-secret-1234567890';

function createTestLogger() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, args });
  return {
    entries,
    errors: () => entries.filter((entry) => entry.level === 'error'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

async function createHarness(t, overrides = {}) {
  const db = createD1Shim();
  const mock = await startMockTelegram();
  const logger = createTestLogger();

  const env = {
    DB: db,
    BOT_TOKEN: '123456:TEST-TOKEN',
    ADMIN_IDS: '42',
    WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_ROOT: mock.url,
    SITE_URL: 'https://example.test',
    ALLOWED_ORIGINS: '*',
    LOG_LEVEL: 'error',
    RATE_LIMIT_MAX: '5',
    ...overrides,
  };

  const app = createWorkerApp(env, { logger });

  t.after(async () => {
    await mock.close();
    db.close();
  });

  return { app, env, mock, logger };
}

function postJson(path, body, headers = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /api/schedule засевает расписание из schedule.json', async (t) => {
  const { app, env } = await createHarness(t);

  const response = await app.fetch(new Request(`${BASE}/api/schedule`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');

  const schedule = await response.json();
  assert.equal(schedule.onsite.length, 10);
  assert.equal(schedule.online.length, 10);
  assert.equal(schedule.onsite[0].title, 'Эриксоновский гипноз');
});

test('POST /api/requests сохраняет заявку и отправляет её в Telegram', async (t) => {
  const { app, env, mock, logger } = await createHarness(t);

  const response = await app.fetch(
    postJson('/api/requests', {
      name: 'Анна',
      contact: '@anna',
      topic: 'therapy',
      message: 'Хочу на сессию',
      consent: true,
    }),
    env,
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, id: 1 });

  const stored = await app.requestService.get(1);
  assert.equal(stored.name, 'Анна');
  assert.equal(stored.status, 'new');

  const sent = mock.last('sendMessage');
  assert.ok(sent, 'должно уйти уведомление в Telegram');
  assert.equal(sent.payload.chat_id, 42);
  assert.match(sent.payload.text, /Новая заявка/);
  assert.equal(logger.errors().length, 0);
});

test('POST /api/requests возвращает ошибки полей', async (t) => {
  const { app, env, mock } = await createHarness(t);

  const response = await app.fetch(postJson('/api/requests', { name: '', contact: '', consent: false }), env);
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.deepEqual(Object.keys(body.fields).sort(), ['consent', 'contact', 'name']);
  assert.equal(mock.messages.length, 0);
});

test('honeypot: спам не сохраняется и не уходит в Telegram', async (t) => {
  const { app, env, mock } = await createHarness(t);

  const response = await app.fetch(
    postJson('/api/requests', { name: 'Bot', contact: 'bot', consent: true, website: 'http://spam' }),
    env,
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await app.requestService.page()).total, 0);
  assert.equal(mock.messages.length, 0);
});

test('ограничение частоты заявок работает через D1', async (t) => {
  const { app, env } = await createHarness(t, { RATE_LIMIT_MAX: '2' });
  const payload = { name: 'Анна', contact: '@anna', consent: true };

  assert.equal((await app.fetch(postJson('/api/requests', payload), env)).status, 201);
  assert.equal((await app.fetch(postJson('/api/requests', payload), env)).status, 201);

  const limited = await app.fetch(postJson('/api/requests', payload), env);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('CORS preflight и 404 для неизвестного API', async (t) => {
  const { app, env } = await createHarness(t);

  const preflight = await app.fetch(
    new Request(`${BASE}/api/requests`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://regressional.ru', 'Access-Control-Request-Method': 'POST' },
    }),
    env,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const missing = await app.fetch(new Request(`${BASE}/api/unknown`), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: 'Не найдено' });
});

test('вебхук Telegram: /start открывает панель управления', async (t) => {
  const { app, env, mock, logger } = await createHarness(t);

  const update = textUpdate(1, '/start', 42);
  const response = await app.fetch(
    new Request(`${BASE}/telegram/${SECRET}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': SECRET,
      },
      body: JSON.stringify(update),
    }),
    env,
  );

  assert.equal(response.status, 200);

  const sent = mock.last('sendMessage');
  assert.ok(sent, 'бот должен ответить на /start');
  assert.match(sent.payload.text, /Панель управления/);
  assert.equal(logger.errors().length, 0);
});

test('вебхук: неверный секрет и отсутствие заголовка отклоняются', async (t) => {
  const { app, env } = await createHarness(t);
  const body = JSON.stringify(textUpdate(1, '/start', 42));

  const wrongPath = await app.fetch(
    new Request(`${BASE}/telegram/wrong-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
      body,
    }),
    env,
  );
  assert.equal(wrongPath.status, 404);

  const noHeader = await app.fetch(
    new Request(`${BASE}/telegram/${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    env,
  );
  assert.equal(noHeader.status, 401);
});

test('GET /api/health отдаёт состояние', async (t) => {
  const { app, env } = await createHarness(t);

  const response = await app.fetch(new Request(`${BASE}/api/health`), env);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.runtime, 'cloudflare-worker');
  assert.equal(body.events.onsite, 10);
});
