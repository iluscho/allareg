import { Bot } from 'grammy';

import { createBotCore } from './botCore.js';
import { createMemoryPendingStore } from './pendingStore.js';

const INIT_TIMEOUT_MS = 20_000;
const COMMANDS_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, message) {
  // Если промис отклонится уже после таймаута, не оставляем необработанный отказ.
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Node-версия бота: длинный polling и состояние в памяти.
 * Вся логика — в botCore.js, здесь только транспорт и жизненный цикл.
 */
export function createBotController({ config, logger, scheduleService, requestService }) {
  const bot = new Bot(config.botToken, {
    client: { apiRoot: config.telegramApiRoot },
  });

  const core = createBotCore({
    bot,
    config,
    logger,
    scheduleService,
    requestService,
    pendingStore: createMemoryPendingStore(),
  });

  async function start() {
    logger.info('Подключение к Telegram…');
    await withTimeout(bot.init(), INIT_TIMEOUT_MS, 'Telegram API не ответил за 20 секунд');

    // Меню команд — украшение: если не получилось, бот всё равно должен работать.
    try {
      await withTimeout(
        bot.api.setMyCommands([
          { command: 'start', description: 'Панель управления' },
          { command: 'events', description: 'Мероприятия' },
          { command: 'requests', description: 'Заявки' },
          { command: 'help', description: 'Помощь' },
          { command: 'cancel', description: 'Отменить ввод' },
          { command: 'id', description: 'Мой Telegram ID' },
        ]),
        COMMANDS_TIMEOUT_MS,
        'Telegram API не ответил при обновлении меню команд',
      );
    } catch (error) {
      logger.warn('Меню команд не обновлено:', error?.description ?? error?.message);
    }

    logger.info(`Бот запущен как @${bot.botInfo.username}`);
    bot
      .start({ onStart: () => logger.info('Получение обновлений Telegram запущено.') })
      .catch((error) => logger.error('Поллинг Telegram остановлен:', error?.description ?? error?.message ?? error));
  }

  async function stop() {
    try {
      await bot.stop();
    } catch (error) {
      logger.debug('Остановка бота:', error?.message);
    }
  }

  return {
    bot,
    start,
    stop,
    notifyNewRequest: core.notifyNewRequest,
    isAdmin: core.isAdmin,
  };
}
