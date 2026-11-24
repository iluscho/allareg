import {
  addPreviewView,
  deleteConfirmView,
  eventCardView,
  eventsMenuView,
  formatListView,
  helpView,
  pendingPromptView,
  requestCardView,
  requestDeleteConfirmView,
  requestsListView,
  rootView,
} from './botViews.js';
import { FORMAT_KEYS, nextNum, validateEventField, validateNumberInput } from './schedule.js';

export const PENDING_TTL_MS = 30 * 60 * 1000;

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

function markup(view) {
  return { ...HTML, reply_markup: { inline_keyboard: view.keyboard } };
}

/**
 * Вся логика бота: команды, кнопки и пошаговые формы.
 * Не зависит от способа доставки обновлений — длинный polling (Node)
 * или вебхук (Cloudflare Workers) — и от хранилища состояния.
 */
export function createBotCore({ bot, config, logger, scheduleService, requestService, pendingStore }) {
  const isAdmin = (userId) => config.adminIds.includes(userId);
  const admins = config.adminIds;

  /** Незавершённый ввод: добавление или правка мероприятия. */
  async function setPending(chatId, value) {
    await pendingStore.set(String(chatId), { ...value, expiresAt: Date.now() + PENDING_TTL_MS });
  }

  async function getPending(chatId) {
    const pending = await pendingStore.get(String(chatId));
    if (!pending) return null;
    if (pending.expiresAt && pending.expiresAt < Date.now()) {
      await pendingStore.remove(String(chatId));
      return null;
    }
    return pending;
  }

  async function clearPending(chatId) {
    await pendingStore.remove(String(chatId));
  }

  async function render(ctx, view) {
    if (!view) return;
    const options = markup(view);
    try {
      await ctx.editMessageText(view.text, options);
    } catch (error) {
      const description = String(error?.description ?? '');
      if (description.includes('message is not modified')) return;
      logger.debug('Не удалось изменить сообщение, отправляю новое:', description || error?.message);
      await ctx.reply(view.text, options).catch(() => {});
    }
  }

  async function renderPrompt(ctx, pending, view) {
    const options = markup(view);
    if (!pending.promptMessageId) {
      const message = await ctx.reply(view.text, options);
      pending.promptMessageId = message.message_id;
      await setPending(ctx.chat.id, pending);
      return;
    }
    try {
      await ctx.api.editMessageText(ctx.chat.id, pending.promptMessageId, view.text, options);
    } catch (error) {
      logger.debug('Не удалось обновить сообщение-подсказку:', error?.description ?? error?.message);
      const message = await ctx.reply(view.text, options);
      pending.promptMessageId = message.message_id;
      await setPending(ctx.chat.id, pending);
    }
  }

  async function rootScreen(ctx) {
    const [{ counts }, totals] = await Promise.all([scheduleService.stats(), requestService.totals()]);
    return rootView({ counts, newRequests: totals.new, siteUrl: config.siteUrl });
  }

  async function eventsScreen() {
    const { counts } = await scheduleService.stats();
    return eventsMenuView({ counts });
  }

  async function formatScreen(format) {
    const schedule = await scheduleService.getSchedule();
    return formatListView(format, schedule);
  }

  // ─── Команды ────────────────────────────────────────────────────────────────

  async function handleStart(ctx) {
    await clearPending(ctx.chat.id);
    logger.info(`/start от ${ctx.from?.id} (${ctx.from?.first_name ?? ''})`);
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply(
        [
          '<b>Это служебный бот сайта regressional.ru</b>',
          '',
          'Бот принимает заявки с сайта и не предназначен для переписки.',
          'Оставить заявку на гипнотерапию можно в форме на сайте.',
        ].join('\n'),
        HTML,
      );
      return;
    }
    const view = await rootScreen();
    await ctx.reply(view.text, markup(view));
  }

  bot.command('start', handleStart);
  bot.command('menu', handleStart);

  bot.command('help', async (ctx) => {
    const view = helpView({ isAdmin: isAdmin(ctx.from?.id), siteUrl: config.siteUrl });
    await ctx.reply(view.text, markup(view));
  });

  bot.command('id', async (ctx) => {
    const id = ctx.from?.id;
    const lines = [`Ваш Telegram ID: <code>${id}</code>`];
    lines.push(isAdmin(id) ? 'Вы администратор этого бота.' : 'Доступа к управлению нет.');
    if (!admins.length) lines.push('', 'ADMIN_IDS пока не настроен на сервере.');
    await ctx.reply(lines.join('\n'), HTML);
  });

  bot.command('cancel', async (ctx) => {
    await clearPending(ctx.chat.id);
    await ctx.reply('Ввод отменён.', markup(await rootScreen()));
  });

  bot.command('events', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await clearPending(ctx.chat.id);
    const view = await eventsScreen();
    await ctx.reply(view.text, markup(view));
  });

  bot.command('requests', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await clearPending(ctx.chat.id);
    const [page, totals] = await Promise.all([requestService.page(1, 5), requestService.totals()]);
    const view = requestsListView({ ...page, newCount: totals.new });
    await ctx.reply(view.text, markup(view));
  });

  // ─── Кнопки ─────────────────────────────────────────────────────────────────

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    const ack = (text, alert = false) =>
      ctx.answerCallbackQuery(alert && text ? { text, show_alert: true } : text ? { text } : {}).catch(() => {});

    if (!isAdmin(userId)) {
      await ack('Нет доступа. Управление ботом доступно только администратору.', true);
      return;
    }

    const [scope, action, arg1, arg2, arg3] = data.split(':');

    try {
      if (scope === 'menu') {
        if (action === 'root') {
          await clearPending(chatId);
          await ack();
          await render(ctx, await rootScreen());
        } else if (action === 'help') {
          await ack();
          await render(ctx, helpView({ isAdmin: true, siteUrl: config.siteUrl }));
        }
        return;
      }

      if (scope === 'ev') {
        await handleEventAction(ctx, { data, action, arg1, arg2, arg3, chatId, ack });
        return;
      }

      if (scope === 'req') {
        await handleRequestAction(ctx, { action, arg1, ack });
        return;
      }

      await ack('Неизвестное действие', true);
    } catch (error) {
      logger.error('Ошибка обработки кнопки', data, error);
      await ack('Не получилось. Попробуйте ещё раз.', true);
    }
  });

  async function handleEventAction(ctx, { action, arg1, arg2, arg3, chatId, ack }) {
    const needsFormat = ['fmt', 'view', 'edit', 'move', 'renum', 'del', 'delok'];
    if (needsFormat.includes(action) && !FORMAT_KEYS.includes(arg1)) {
      await ack('Кнопка устарела. Откройте раздел заново.', true);
      return;
    }

    if (action === 'menu') {
      await ack();
      await render(ctx, await eventsScreen());
      return;
    }

    if (action === 'fmt') {
      await ack();
      await render(ctx, await formatScreen(arg1));
      return;
    }

    if (action === 'view') {
      const format = arg1;
      const index = Number.parseInt(arg2, 10);
      const schedule = await scheduleService.getSchedule();
      const view = eventCardView(format, index, schedule[format] ?? []);
      await ack();
      await render(ctx, view ?? formatListView(format, schedule));
      return;
    }

    if (action === 'add') {
      await ack();
      const view = {
        text: ['<b>Добавление мероприятия</b>', '', 'Выберите формат:'].join('\n'),
        keyboard: [
          [
            { text: '📍 Очно · Оренбург', callback_data: 'ev:addf:onsite' },
            { text: '💻 Онлайн', callback_data: 'ev:addf:online' },
          ],
          [{ text: '❌ Отмена', callback_data: 'ev:cancel' }],
        ],
      };
      await render(ctx, view);
      return;
    }

    if (action === 'addf') {
      const format = arg1;
      if (!FORMAT_KEYS.includes(format)) {
        await ack('Неизвестный формат', true);
        return;
      }
      const schedule = await scheduleService.getSchedule();
      const pending = {
        kind: 'add',
        step: 'dates',
        format,
        draft: { format, dates: '', title: '', num: '', suggestedNum: nextNum(schedule, format) },
        promptMessageId: ctx.callbackQuery.message?.message_id,
      };
      await setPending(chatId, pending);
      await ack();
      await renderPrompt(ctx, pending, pendingPromptView({ kind: 'add', step: 'dates' }));
      return;
    }

    if (action === 'edit') {
      const format = arg1;
      const index = Number.parseInt(arg2, 10);
      const field = arg3;
      const schedule = await scheduleService.getSchedule();
      const event = (schedule[format] ?? [])[index];
      if (!event) {
        await ack('Мероприятие не найдено', true);
        return;
      }
      const pending = {
        kind: 'edit',
        step: field,
        target: { format, index },
        promptMessageId: ctx.callbackQuery.message?.message_id,
      };
      await setPending(chatId, pending);
      await ack();
      await renderPrompt(
        ctx,
        pending,
        pendingPromptView({
          kind: 'edit',
          step: field,
          event,
          cancelData: `ev:view:${format}:${index}`,
        }),
      );
      return;
    }

    if (action === 'save') {
      const pending = await getPending(chatId);
      if (!pending || pending.kind !== 'add' || pending.step !== 'confirm') {
        await ack('Черновик устарел. Начните добавление заново.', true);
        return;
      }
      const { format, dates, title, num } = pending.draft;
      const outcome = await scheduleService.add(format, { num, dates, title });
      await clearPending(chatId);
      await ack('Мероприятие добавлено');
      const schedule = await scheduleService.getSchedule();
      await render(ctx, eventCardView(format, outcome.index, schedule[format] ?? []));
      return;
    }

    if (action === 'cancel') {
      await clearPending(chatId);
      await ack('Отменено');
      await render(ctx, await eventsScreen());
      return;
    }

    if (action === 'move') {
      const format = arg1;
      const index = Number.parseInt(arg2, 10);
      const direction = arg3 === 'up' ? -1 : 1;
      const result = await scheduleService.move(format, index, direction);
      if (!result.moved) {
        await ack(result.reason, true);
        return;
      }
      const newIndex = index + direction;
      const view = eventCardView(format, newIndex, result.schedule[format] ?? []);
      await ack('Перемещено');
      await render(ctx, view ?? formatListView(format, result.schedule));
      return;
    }

    if (action === 'renum') {
      const format = arg1;
      const result = await scheduleService.renumber(format);
      await ack('Номера обновлены');
      await render(ctx, formatListView(format, result.schedule));
      return;
    }

    if (action === 'del') {
      const format = arg1;
      const index = Number.parseInt(arg2, 10);
      const schedule = await scheduleService.getSchedule();
      await ack();
      await render(ctx, deleteConfirmView(format, index, schedule[format] ?? []));
      return;
    }

    if (action === 'delok') {
      const format = arg1;
      const index = Number.parseInt(arg2, 10);
      const result = await scheduleService.remove(format, index);
      await ack('Удалено');
      await render(ctx, formatListView(format, result.schedule));
      return;
    }

    await ack('Неизвестное действие', true);
  }

  async function handleRequestAction(ctx, { action, arg1, ack }) {
    const id = Number.parseInt(arg1, 10);

    if (action === 'list') {
      const page = Number.parseInt(arg1, 10) || 1;
      const [data, totals] = await Promise.all([requestService.page(page, 5), requestService.totals()]);
      await ack();
      await render(ctx, requestsListView({ ...data, newCount: totals.new }));
      return;
    }

    if (action === 'view') {
      const request = await requestService.get(id);
      await ack();
      await render(ctx, requestCardView(request, { timezone: config.timezone }));
      return;
    }

    if (action === 'done' || action === 'new') {
      const request = await requestService.setStatus(id, action === 'done' ? 'done' : 'new');
      if (!request) {
        await ack('Заявка не найдена', true);
        return;
      }
      await ack(action === 'done' ? 'Отмечено как обработанная' : 'Возвращено в новые');
      await render(ctx, requestCardView(request, { timezone: config.timezone }));
      return;
    }

    if (action === 'del') {
      const request = await requestService.get(id);
      await ack();
      await render(ctx, requestDeleteConfirmView(request));
      return;
    }

    if (action === 'delok') {
      await requestService.remove(id);
      const [data, totals] = await Promise.all([requestService.page(1, 5), requestService.totals()]);
      await ack('Заявка удалена');
      await render(ctx, requestsListView({ ...data, newCount: totals.new }));
      return;
    }

    await ack('Неизвестное действие', true);
  }

  // ─── Ввод текста (пошаговые формы) ──────────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAdmin(ctx.from?.id)) return;

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Неизвестная команда. Панель управления: /start');
      return;
    }

    const pending = await getPending(chatId);
    if (!pending) {
      const view = await rootScreen();
      await ctx.reply(`Не понял сообщение. Выберите действие:\n\n${view.text}`, markup(view));
      return;
    }

    try {
      if (pending.kind === 'add') {
        await handleAddInput(ctx, pending, text);
        return;
      }
      if (pending.kind === 'edit') {
        await handleEditInput(ctx, pending, text);
      }
    } catch (error) {
      logger.error('Ошибка ввода в боте', error);
      await clearPending(chatId);
      await ctx.reply('Что-то сломалось, ввод отменён. Попробуйте снова через /start');
    }
  });

  async function handleAddInput(ctx, pending, text) {
    const chatId = ctx.chat.id;

    if (pending.step === 'confirm') {
      await ctx.reply('Нажмите «✅ Сохранить» или «❌ Отмена» на сообщении выше.');
      return;
    }

    if (pending.step === 'dates' || pending.step === 'title') {
      const validation = validateEventField(pending.step, text);
      if (!validation.ok) {
        await ctx.reply(`⚠️ ${validation.error}`);
        return;
      }
      pending.draft[pending.step] = validation.value;
      pending.step = pending.step === 'dates' ? 'title' : 'num';
      await setPending(chatId, pending);
      await renderPrompt(ctx, pending, pendingPromptView({ kind: 'add', step: pending.step, draft: pending.draft }));
      return;
    }

    if (pending.step === 'num') {
      const schedule = await scheduleService.getSchedule();
      const validation = validateNumberInput(text, schedule, pending.format);
      if (!validation.ok) {
        await ctx.reply(`⚠️ ${validation.error}`);
        return;
      }
      pending.draft.num = validation.value;
      pending.step = 'confirm';
      await setPending(chatId, pending);
      await renderPrompt(ctx, pending, addPreviewView(pending.draft));
      return;
    }
  }

  async function handleEditInput(ctx, pending, text) {
    const { format, index } = pending.target;
    const result = await scheduleService.update(format, index, pending.step, text);
    if (!result.ok) {
      await ctx.reply(`⚠️ ${result.error}`);
      return;
    }

    await clearPending(ctx.chat.id);
    const schedule = await scheduleService.getSchedule();
    const view = eventCardView(format, index, schedule[format] ?? []) ?? formatListView(format, schedule);
    const options = markup(view);
    try {
      await ctx.api.editMessageText(ctx.chat.id, pending.promptMessageId, view.text, options);
    } catch {
      await ctx.reply(view.text, options);
    }
  }

  // ─── Служебное ──────────────────────────────────────────────────────────────

  bot.catch((error) => {
    logger.error('Необработанная ошибка бота:', error?.error ?? error);
  });

  /** Отправляет карточку новой заявки всем администраторам. */
  async function notifyNewRequest(request) {
    if (!admins.length) {
      logger.warn(`Заявка #${request.id} сохранена, но ADMIN_IDS не задан — уведомление не отправлено.`);
      return;
    }
    const view = requestCardView(request, { timezone: config.timezone, notification: true });
    await Promise.all(
      admins.map(async (adminId) => {
        try {
          await bot.api.sendMessage(adminId, view.text, markup(view));
        } catch (error) {
          logger.warn(
            `Не удалось отправить заявку #${request.id} администратору ${adminId}: ${error?.description ?? error?.message}. ` +
              'Напишите боту /start из этого аккаунта.',
          );
        }
      }),
    );
  }

  return { notifyNewRequest, isAdmin };
}
