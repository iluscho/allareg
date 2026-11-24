import 'dotenv/config';
import path from 'node:path';

import { createBotController } from './bot.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { emptySchedule } from './schedule.js';
import { createScheduleService, createRequestService } from './services.js';
import { createHttpApp } from './server.js';
import { seedScheduleIfNeeded } from './seed.js';
import { JsonStore } from './storage.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

logger.info('Запуск allareg-bot');
logger.info(`Каталог данных: ${config.dataDir}`);

const scheduleStore = new JsonStore(path.join(config.dataDir, 'schedule.json'), emptySchedule());
const requestsStore = new JsonStore(path.join(config.dataDir, 'requests.json'), { nextId: 1, items: [] });

const scheduleService = createScheduleService({ store: scheduleStore, logger });
const requestService = createRequestService({ store: requestsStore, logger });

await seedScheduleIfNeeded({ store: scheduleStore, seedPath: config.seedSchedulePath, logger });

if (!config.botToken) {
  logger.warn('BOT_TOKEN не задан: бот не будет запущен, заявки только сохраняются в файл.');
}
if (!config.adminIds.length) {
  logger.warn('ADMIN_IDS не задан: управление мероприятиями и уведомления будут недоступны.');
}

let botController = null;
let botReady = false;

if (config.botToken) {
  botController = createBotController({ config, logger, scheduleService, requestService });
}

/**
 * Заявка сохраняется всегда, даже если бот ещё не подключился или упал:
 * в худшем случае она окажется в логе и в data/requests.json.
 */
async function notifyNewRequest(request) {
  if (botController && botReady) {
    try {
      await botController.notifyNewRequest(request);
      return;
    } catch (error) {
      logger.warn(`Не удалось отправить уведомление о заявке #${request.id}: ${error?.message ?? error}`);
    }
  }
  logger.warn(
    `Заявка #${request.id} сохранена, но бот не запущен. ` +
      `Имя: ${request.name}, контакт: ${request.contact}, тема: ${request.topic}`,
  );
}

const app = createHttpApp({ config, scheduleService, requestService, logger, notifyNewRequest });
const server = app.listen(config.port, config.host, () => {
  logger.info(`API и страница: http://${config.host}:${config.port}`);
  logger.info(`Расписание: http://${config.host}:${config.port}/api/schedule`);
  logger.info('Приём заявок: POST /api/requests');
});

server.on('error', (error) => {
  logger.error(`Не удалось открыть порт ${config.port}: ${error.message}`);
  process.exitCode = 1;
});

// Бот подключается после старта API: даже если Telegram недоступен,
// сайт продолжает отдавать расписание и принимать заявки.
if (botController) {
  botController
    .start()
    .then(() => {
      botReady = true;
      logger.info(`Администраторы: ${config.adminIds.join(', ') || 'не заданы'}`);
    })
    .catch((error) => {
      logger.error(`Не удалось запустить бота: ${error?.description ?? error?.message ?? error}`);
      logger.error('Проверьте BOT_TOKEN и доступ к api.telegram.org. API сайта работает, заявки сохраняются.');
      botController = null;
    });
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal}: останавливаюсь…`);
  await new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 5000).unref?.();
  });
  if (botController) await botController.stop();
  logger.info('Остановлено.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Необработанная ошибка (promise):', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Необработанная ошибка:', error);
  process.exit(1);
});
