import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBotController } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { emptySchedule } from '../src/schedule.js';
import { seedScheduleIfNeeded } from '../src/seed.js';
import { createRequestService, createScheduleService } from '../src/services.js';
import { JsonStore } from '../src/storage.js';
import { callbackUpdate, startMockTelegram, textUpdate } from './mockTelegram.js';

const SEED = fileURLToPath(new URL('../schedule.json', import.meta.url));
const ADMIN_ID = 42;

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

async function createHarness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allareg-bot-'));
  const mock = await startMockTelegram();
  const logger = createTestLogger();

  const config = loadConfig(
    {
      BOT_TOKEN: '123456:TEST-TOKEN',
      ADMIN_IDS: String(ADMIN_ID),
      DATA_DIR: dir,
      TELEGRAM_API_ROOT: mock.url,
      LOG_LEVEL: 'error',
      TZ_NAME: 'Europe/Moscow',
      SEED_SCHEDULE: SEED,
    },
    dir,
  );

  const scheduleStore = new JsonStore(path.join(dir, 'schedule.json'), emptySchedule());
  const scheduleService = createScheduleService({ store: scheduleStore, logger });
  const requestService = createRequestService({
    store: new JsonStore(path.join(dir, 'requests.json'), { nextId: 1, items: [] }),
    logger,
  });
  await seedScheduleIfNeeded({ store: scheduleStore, seedPath: SEED, logger });

  const controller = createBotController({ config, logger, scheduleService, requestService });
  await controller.bot.init();

  t.after(async () => {
    await controller.stop();
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { mock, controller, scheduleService, requestService, logger, config };
}

test('/start показывает панель управления администратору', async (t) => {
  const { mock, controller, logger } = await createHarness(t);

  await controller.bot.handleUpdate(textUpdate(1, '/start', ADMIN_ID));

  const last = mock.last('sendMessage');
  assert.ok(last, 'бот должен отправить сообщение');
  assert.match(last.payload.text, /Панель управления/);
  assert.match(last.payload.text, /очно — 10, онлайн — 10/);

  const keyboard = last.payload.reply_markup.inline_keyboard;
  const buttons = keyboard.flat().map((button) => button.callback_data);
  assert.ok(buttons.includes('ev:menu'));
  assert.ok(buttons.includes('req:list:1'));
  assert.equal(logger.errors().length, 0);
});

test('посторонний пользователь не получает доступ к управлению', async (t) => {
  const { mock, controller, logger } = await createHarness(t);

  await controller.bot.handleUpdate(textUpdate(1, '/start', 999));
  assert.match(mock.last('sendMessage').payload.text, /служебный бот/);

  await controller.bot.handleUpdate(callbackUpdate(2, 'ev:menu', 500, 999));
  const answer = mock.last('answerCallbackQuery');
  assert.equal(answer.payload.show_alert, true);
  assert.match(answer.payload.text, /Нет доступа/);

  assert.equal(logger.errors().length, 0);
});

test('сценарий добавления: формат → даты → название → номер → сохранение', async (t) => {
  const { mock, controller, scheduleService, logger } = await createHarness(t);
  const bot = controller.bot;

  await bot.handleUpdate(callbackUpdate(1, 'ev:add'));
  assert.match(mock.texts().at(-1), /Выберите формат/);

  await bot.handleUpdate(callbackUpdate(2, 'ev:addf:onsite'));
  assert.match(mock.texts().at(-1), /Шаг 1 из 3/);

  await bot.handleUpdate(textUpdate(3, '1–2 марта 2028'));
  assert.match(mock.texts().at(-1), /Шаг 2 из 3/);

  await bot.handleUpdate(textUpdate(4, '  Новый   модуль '));
  assert.match(mock.texts().at(-1), /Шаг 3 из 3/);

  await bot.handleUpdate(textUpdate(5, '-'));
  assert.match(mock.texts().at(-1), /Проверьте мероприятие/);

  await bot.handleUpdate(callbackUpdate(6, 'ev:save'));

  const schedule = await scheduleService.getSchedule();
  assert.equal(schedule.onsite.length, 11);
  assert.deepEqual(schedule.onsite.at(-1), {
    num: '11',
    dates: '1–2 марта 2028',
    title: 'Новый модуль',
  });

  // Карточка нового мероприятия показана в том же сообщении.
  assert.match(mock.texts().at(-1), /Новый модуль/);
  assert.equal(logger.errors().length, 0);
});

test('изменение названия, перемещение и защита краёв списка', async (t) => {
  const { mock, controller, scheduleService, logger } = await createHarness(t);
  const bot = controller.bot;

  await bot.handleUpdate(callbackUpdate(1, 'ev:view:onsite:0'));
  await bot.handleUpdate(callbackUpdate(2, 'ev:edit:onsite:0:title'));
  assert.match(mock.texts().at(-1), /Новые название/);

  await bot.handleUpdate(textUpdate(3, 'Изменённое название'));
  let schedule = await scheduleService.getSchedule();
  assert.equal(schedule.onsite[0].title, 'Изменённое название');

  await bot.handleUpdate(callbackUpdate(4, 'ev:move:onsite:0:down'));
  schedule = await scheduleService.getSchedule();
  assert.equal(schedule.onsite[0].title, 'Прошлые жизни');
  assert.equal(schedule.onsite[1].title, 'Изменённое название');

  await bot.handleUpdate(callbackUpdate(5, 'ev:move:onsite:9:down'));
  const answer = mock.last('answerCallbackQuery');
  assert.equal(answer.payload.show_alert, true);
  assert.match(answer.payload.text, /последнее/);

  assert.equal(logger.errors().length, 0);
});

test('удаление мероприятия с подтверждением', async (t) => {
  const { mock, controller, scheduleService, logger } = await createHarness(t);
  const bot = controller.bot;

  await bot.handleUpdate(callbackUpdate(1, 'ev:del:onsite:2'));
  assert.match(mock.texts().at(-1), /Удалить мероприятие/);

  await bot.handleUpdate(callbackUpdate(2, 'ev:delok:onsite:2'));

  const schedule = await scheduleService.getSchedule();
  assert.equal(schedule.onsite.length, 9);
  assert.ok(!schedule.onsite.some((event) => event.title === 'Психологические и духовные аспекты'));
  assert.equal(logger.errors().length, 0);
});

test('заявка приходит администратору и помечается обработанной', async (t) => {
  const { mock, controller, requestService, logger } = await createHarness(t);
  const bot = controller.bot;

  const request = await requestService.create({
    name: 'Гость',
    contact: '@guest',
    topic: 'therapy',
    message: 'Хочу на сессию',
    preferredTime: 'после 18:00',
  });

  await controller.notifyNewRequest(request);

  const sent = mock.last('sendMessage');
  assert.equal(sent.payload.chat_id, ADMIN_ID);
  assert.match(sent.payload.text, /Новая заявка/);
  assert.match(sent.payload.text, /Гость/);
  assert.match(sent.payload.text, /@guest/);
  assert.ok(sent.payload.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === `req:done:${request.id}`));

  await bot.handleUpdate(callbackUpdate(1, `req:done:${request.id}`));
  assert.equal((await requestService.get(request.id)).status, 'done');

  await bot.handleUpdate(callbackUpdate(2, 'req:list:1'));
  assert.match(mock.texts().at(-1), /Заявки на гипнотерапию/);

  await bot.handleUpdate(callbackUpdate(3, `req:del:${request.id}`));
  assert.match(mock.texts().at(-1), /Удалить заявку/);
  await bot.handleUpdate(callbackUpdate(4, `req:delok:${request.id}`));
  assert.equal(await requestService.get(request.id), null);

  assert.equal(logger.errors().length, 0);
});

test('неверный ввод не ломает пошаговую форму', async (t) => {
  const { mock, controller, scheduleService, logger } = await createHarness(t);
  const bot = controller.bot;

  await bot.handleUpdate(callbackUpdate(1, 'ev:addf:online'));
  await bot.handleUpdate(textUpdate(2, 'a'.repeat(200)));
  assert.match(mock.texts().at(-1), /Слишком длинно/);

  await bot.handleUpdate(textUpdate(3, '5–6 июня 2028'));
  await bot.handleUpdate(textUpdate(4, 'Онлайн-модуль'));
  await bot.handleUpdate(textUpdate(5, 'abc'));
  assert.match(mock.texts().at(-1), /Номер — это до трёх цифр/);

  await bot.handleUpdate(textUpdate(6, '12'));
  await bot.handleUpdate(callbackUpdate(7, 'ev:save'));

  const schedule = await scheduleService.getSchedule();
  assert.equal(schedule.online.length, 11);
  assert.equal(schedule.online.at(-1).num, '12');
  assert.equal(logger.errors().length, 0);
});
