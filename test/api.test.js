import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { emptySchedule } from '../src/schedule.js';
import { seedScheduleIfNeeded } from '../src/seed.js';
import { createHttpApp } from '../src/server.js';
import { createRequestService, createScheduleService } from '../src/services.js';
import { JsonStore } from '../src/storage.js';

const SEED = fileURLToPath(new URL('../schedule.json', import.meta.url));

async function createHarness(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allareg-api-'));
  const config = loadConfig(
    {
      DATA_DIR: dir,
      LOG_LEVEL: 'error',
      RATE_LIMIT_MAX: '3',
      SEED_SCHEDULE: SEED,
      ...env,
    },
    dir,
  );
  const logger = createLogger('error');
  const scheduleStore = new JsonStore(path.join(dir, 'schedule.json'), emptySchedule());
  const scheduleService = createScheduleService({ store: scheduleStore, logger });
  const requestService = createRequestService({
    store: new JsonStore(path.join(dir, 'requests.json'), { nextId: 1, items: [] }),
    logger,
  });
  await seedScheduleIfNeeded({ store: scheduleStore, seedPath: SEED, logger });

  const notified = [];
  const app = createHttpApp({
    config,
    scheduleService,
    requestService,
    logger,
    notifyNewRequest: async (request) => {
      notified.push(request);
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    scheduleService,
    requestService,
    notified,
    async close() {
      clearInterval(app.locals.limiterTimer);
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function jsonRequest(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('GET /api/schedule отдаёт расписание из хранилища', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/api/schedule`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const schedule = await response.json();
  assert.equal(schedule.onsite.length, 10);
  assert.equal(schedule.online.length, 10);
  assert.equal(schedule.onsite[0].title, 'Эриксоновский гипноз');
});

test('POST /api/requests сохраняет заявку и уведомляет администратора', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.base}/api/requests`,
    jsonRequest({
      name: 'Анна',
      contact: '+7 900 000-00-00',
      topic: 'therapy',
      message: 'Хочу на сессию',
      preferredTime: 'после 18:00',
      consent: true,
    }),
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, id: 1 });

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].name, 'Анна');

  const stored = await harness.requestService.get(1);
  assert.equal(stored.contact, '+7 900 000-00-00');
  assert.equal(stored.status, 'new');
});

test('POST /api/requests возвращает ошибки полей', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/api/requests`, jsonRequest({ name: '', contact: '', consent: false }));
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(Object.keys(body.fields).sort(), ['consent', 'contact', 'name']);
  assert.equal(harness.notified.length, 0);
});

test('honeypot: спам не сохраняется, но ответ успешный', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.base}/api/requests`,
    jsonRequest({ name: 'Bot', contact: 'bot', consent: true, website: 'http://spam.example' }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(harness.notified.length, 0);
  assert.equal((await harness.requestService.page()).total, 0);
});

test('ограничение частоты: не больше N заявок за окно', async (t) => {
  const harness = await createHarness({ RATE_LIMIT_MAX: '2' });
  t.after(() => harness.close());

  const payload = jsonRequest({ name: 'Анна', contact: '@anna', consent: true });

  assert.equal((await fetch(`${harness.base}/api/requests`, payload)).status, 201);
  assert.equal((await fetch(`${harness.base}/api/requests`, payload)).status, 201);

  const limited = await fetch(`${harness.base}/api/requests`, payload);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const body = await limited.json();
  assert.match(body.error, /Слишком много/);
});

test('CORS preflight и заголовки для формы', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const preflight = await fetch(`${harness.base}/api/requests`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://regressional.ru',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
});

test('неизвестный путь API отдаёт JSON 404', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/api/unknown`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'Не найдено' });
});

test('JSONStore не теряет данные при параллельных обновлениях', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allareg-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new JsonStore(path.join(dir, 'counter.json'), { value: 0 });
  await store.write({ value: 0 });

  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.update((data) => {
        data.value += 1;
        return data;
      }),
    ),
  );

  const result = await store.read();
  assert.equal(result.value, 20);
});
