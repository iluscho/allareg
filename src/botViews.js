import { FORMATS, listEvents } from './schedule.js';

const TELEGRAM_TEXT_LIMIT = 4000;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function clampText(text) {
  return text.length > TELEGRAM_TEXT_LIMIT
    ? `${text.slice(0, TELEGRAM_TEXT_LIMIT)}\n\n…список обрезан`
    : text;
}

function plural(count, one, few, many) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

export function eventsWord(count) {
  return plural(count, 'мероприятие', 'мероприятия', 'мероприятий');
}

export function requestsWord(count) {
  return plural(count, 'заявка', 'заявки', 'заявок');
}

export function formatDateTime(iso, timezone = 'Europe/Moscow') {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function rootView({ counts, newRequests, siteUrl }) {
  const text = [
    '<b>Панель управления</b>',
    '',
    `Мероприятия: очно — ${counts.onsite}, онлайн — ${counts.online}`,
    `Новых заявок: ${newRequests}`,
    `Сайт: ${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}`,
    '',
    'Выберите раздел:',
  ].join('\n');

  const keyboard = [
    [
      { text: `📅 Мероприятия (${counts.onsite + counts.online})`, callback_data: 'ev:menu' },
      { text: `📨 Заявки${newRequests ? ` (${newRequests})` : ''}`, callback_data: 'req:list:1' },
    ],
    [{ text: '➕ Добавить мероприятие', callback_data: 'ev:add' }],
    [{ text: 'ℹ️ Помощь', callback_data: 'menu:help' }],
  ];

  return { text, keyboard };
}

export function eventsMenuView({ counts }) {
  const text = [
    '<b>Мероприятия</b>',
    '',
    `Очно · Оренбург — ${counts.onsite} ${eventsWord(counts.onsite)}`,
    `Онлайн — ${counts.online} ${eventsWord(counts.online)}`,
    '',
    'Выберите формат, чтобы посмотреть и изменить список.',
  ].join('\n');

  const keyboard = [
    [
      { text: `📍 Очно (${counts.onsite})`, callback_data: 'ev:fmt:onsite' },
      { text: `💻 Онлайн (${counts.online})`, callback_data: 'ev:fmt:online' },
    ],
    [{ text: '➕ Добавить мероприятие', callback_data: 'ev:add' }],
    [{ text: '🏠 В меню', callback_data: 'menu:root' }],
  ];

  return { text, keyboard };
}

export function formatListView(format, schedule) {
  const events = listEvents(schedule, format);
  const label = FORMATS[format].label;

  const lines = events.map(
    (event) => `<b>${escapeHtml(event.num)}</b> · ${escapeHtml(event.dates)}\n    ${escapeHtml(event.title)}`,
  );

  const text = clampText(
    [
      `<b>${escapeHtml(label)}</b>`,
      `Всего: ${events.length} ${eventsWord(events.length)}`,
      '',
      events.length ? lines.join('\n') : 'Пока нет ни одного мероприятия.',
      events.length ? '\nНажмите на мероприятие, чтобы изменить или удалить его.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const buttons = events.map((event, index) => ({
    text: `${event.num} · ${truncate(event.title, 26)}`,
    callback_data: `ev:view:${format}:${index}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  rows.push([{ text: '➕ Добавить', callback_data: 'ev:add' }]);
  if (events.length > 1) rows.push([{ text: '🔢 Перенумеровать 01…N', callback_data: `ev:renum:${format}` }]);
  rows.push([{ text: '⬅️ К форматам', callback_data: 'ev:menu' }]);

  return { text, keyboard: rows };
}

export function eventCardView(format, index, events) {
  const event = events[index];
  if (!event) return null;
  const total = events.length;

  const label = FORMATS[format].label;
  const text = [
    `<b>${escapeHtml(event.num)} · ${escapeHtml(event.title)}</b>`,
    escapeHtml(label),
    '',
    `Даты: ${escapeHtml(event.dates)}`,
    '',
    `Позиция ${index + 1} из ${total}`,
  ].join('\n');

  const keyboard = [
    [
      { text: '✏️ Даты', callback_data: `ev:edit:${format}:${index}:dates` },
      { text: '✏️ Название', callback_data: `ev:edit:${format}:${index}:title` },
    ],
    [{ text: '🔢 Номер', callback_data: `ev:edit:${format}:${index}:num` }],
    [
      { text: '⬆️ Выше', callback_data: `ev:move:${format}:${index}:up` },
      { text: '⬇️ Ниже', callback_data: `ev:move:${format}:${index}:down` },
    ],
    [{ text: '🗑 Удалить', callback_data: `ev:del:${format}:${index}` }],
    [{ text: '⬅️ К списку', callback_data: `ev:fmt:${format}` }],
  ];

  return { text, keyboard };
}

export function addPreviewView(draft) {
  const text = [
    '<b>Проверьте мероприятие</b>',
    '',
    `Формат: ${escapeHtml(FORMATS[draft.format].label)}`,
    `Номер: ${escapeHtml(draft.num)}`,
    `Даты: ${escapeHtml(draft.dates)}`,
    `Название: ${escapeHtml(draft.title)}`,
    '',
    'Сохранить?',
  ].join('\n');

  const keyboard = [
    [
      { text: '✅ Сохранить', callback_data: 'ev:save' },
      { text: '❌ Отмена', callback_data: 'ev:cancel' },
    ],
  ];

  return { text, keyboard };
}

export function deleteConfirmView(format, index, events) {
  const event = events[index];
  const text = event
    ? [
        '<b>Удалить мероприятие?</b>',
        '',
        `${escapeHtml(event.num)} · ${escapeHtml(event.dates)}`,
        escapeHtml(event.title),
        '',
        'Действие нельзя отменить.',
      ].join('\n')
    : 'Мероприятие не найдено.';

  const keyboard = [
    [
      { text: '🗑 Да, удалить', callback_data: `ev:delok:${format}:${index}` },
      { text: '↩️ Оставить', callback_data: `ev:view:${format}:${index}` },
    ],
  ];

  return { text, keyboard };
}

export function requestsListView({ items, total, page, pages, newCount }) {
  const text = [
    '<b>Заявки на гипнотерапию</b>',
    `Всего: ${total} · Новых: ${newCount}`,
    pages > 1 ? `Страница ${page} из ${pages}` : '',
    '',
    total ? 'Нажмите на заявку, чтобы открыть её.' : 'Заявок пока нет.',
  ]
    .filter(Boolean)
    .join('\n');

  const buttons = items.map((item) => ({
    text: `${item.status === 'new' ? '🆕' : '✅'} #${item.id} · ${truncate(item.name, 18)} · ${formatDateTime(item.createdAt).slice(0, 5)}`,
    callback_data: `req:view:${item.id}`,
  }));
  const rows = buttons.map((button) => [button]);

  const nav = [];
  if (page > 1) nav.push({ text: '◀️ Новее', callback_data: `req:list:${page - 1}` });
  if (page < pages) nav.push({ text: 'Старше ▶️', callback_data: `req:list:${page + 1}` });
  if (nav.length) rows.push(nav);

  rows.push([{ text: '🏠 В меню', callback_data: 'menu:root' }]);

  return { text, keyboard: rows };
}

export function requestCardView(request, { timezone, notification = false } = {}) {
  if (!request) return { text: 'Заявка не найдена.', keyboard: [[{ text: '⬅️ К списку', callback_data: 'req:list:1' }]] };

  const status = request.status === 'new' ? '🆕 новая' : '✅ обработана';
  const header = notification ? '🔔 <b>Новая заявка</b>' : `<b>Заявка #${request.id}</b>`;

  const lines = [
    `${header} · ${status}`,
    `${formatDateTime(request.createdAt, timezone)}`,
    '',
    `<b>Имя:</b> ${escapeHtml(request.name)}`,
    `<b>Контакт:</b> ${escapeHtml(request.contact)}`,
    `<b>Тема:</b> ${escapeHtml(request.topicLabel)}`,
  ];

  if (request.preferredTime) lines.push(`<b>Удобное время:</b> ${escapeHtml(request.preferredTime)}`);
  if (request.message) lines.push('', `<b>Сообщение:</b>\n${escapeHtml(truncate(request.message, 1200))}`);
  lines.push('', request.source === 'site' ? 'Источник: форма на сайте' : 'Источник: бот');

  const keyboard = [
    [
      request.status === 'new'
        ? { text: '✅ Обработана', callback_data: `req:done:${request.id}` }
        : { text: '↩️ Вернуть в новые', callback_data: `req:new:${request.id}` },
    ],
    [{ text: '🗑 Удалить', callback_data: `req:del:${request.id}` }],
    [{ text: '⬅️ К списку', callback_data: 'req:list:1' }],
  ];

  return { text: clampText(lines.join('\n')), keyboard };
}

export function requestDeleteConfirmView(request) {
  const text = request
    ? [`<b>Удалить заявку #${request.id}?</b>`, '', `${escapeHtml(request.name)} · ${escapeHtml(request.contact)}`, '', 'Действие нельзя отменить.'].join('\n')
    : 'Заявка не найдена.';

  const keyboard = [
    [
      { text: '🗑 Да, удалить', callback_data: `req:delok:${request?.id ?? 0}` },
      { text: '↩️ Оставить', callback_data: `req:view:${request?.id ?? 0}` },
    ],
  ];

  return { text, keyboard };
}

export function helpView({ isAdmin, siteUrl }) {
  if (!isAdmin) {
    return {
      text: [
        '<b>Это служебный бот сайта</b>',
        escapeHtml(siteUrl.replace(/^https?:\/\//, '')),
        '',
        'Бот принимает заявки с сайта и не предназначен для переписки.',
        'Чтобы оставить заявку, воспользуйтесь формой на сайте.',
      ].join('\n'),
      keyboard: [],
    };
  }

  const text = [
    '<b>Как пользоваться ботом</b>',
    '',
    '<b>Мероприятия</b>',
    '• «➕ Добавить мероприятие» — даты, название, номер.',
    '• Нажмите на мероприятие в списке, чтобы изменить даты, название или номер, поднять/опустить его и удалить.',
    '• Изменения сразу попадают на сайт (формат, порядок и нумерация — как в списке).',
    '',
    '<b>Заявки</b>',
    '• Каждая заявка с формы приходит сюда отдельным сообщением.',
    '• «✅ Обработана» помечает заявку, «🗑 Удалить» удаляет её навсегда.',
    '',
    '<b>Команды</b>',
    '/start — панель управления',
    '/events — мероприятия',
    '/requests — заявки',
    '/cancel — отменить ввод',
    '/id — узнать свой Telegram ID',
  ].join('\n');

  return { text, keyboard: [[{ text: '🏠 В меню', callback_data: 'menu:root' }]] };
}

export function pendingPromptView({ kind, step, event, draft, cancelData = 'menu:root' }) {
  if (kind === 'add') {
    const steps = {
      dates: [
        '<b>Шаг 1 из 3 · Даты</b>',
        '',
        'Отправьте даты так, как они должны выглядеть на сайте.',
        'Например: <code>12–13 декабря 2026</code>',
      ],
      title: [
        '<b>Шаг 2 из 3 · Название</b>',
        '',
        'Отправьте название мероприятия.',
        'Например: <code>Эриксоновский гипноз</code>',
      ],
      num: [
        '<b>Шаг 3 из 3 · Номер</b>',
        '',
        'Отправьте номер мероприятия (до трёх цифр) или «-», чтобы присвоить следующий по порядку.',
        draft?.suggestedNum ? `Следующий по порядку: <code>${escapeHtml(draft.suggestedNum)}</code>` : '',
      ],
    };
    return {
      text: steps[step].filter(Boolean).join('\n'),
      keyboard: [[{ text: '❌ Отмена', callback_data: 'ev:cancel' }]],
    };
  }

  const labels = { dates: 'даты', title: 'название', num: 'номер' };
  const examples = {
    dates: 'Например: <code>16–17 января 2027</code>',
    title: 'Например: <code>Прошлые жизни</code>',
    num: 'Например: <code>11</code> (до трёх цифр)',
  };
  const text = [
    `<b>Новые ${labels[step] ?? 'данные'}</b>`,
    event ? `Для: ${escapeHtml(event.num)} · ${escapeHtml(event.title)}` : '',
    '',
    `Отправьте новое значение. ${examples[step] ?? ''}`,
    '',
    '/cancel — отмена',
  ]
    .filter(Boolean)
    .join('\n');

  return { text, keyboard: [[{ text: '❌ Отмена', callback_data: cancelData }]] };
}

export function errorView(message) {
  return { text: `⚠️ ${escapeHtml(message)}`, keyboard: [[{ text: '🏠 В меню', callback_data: 'menu:root' }]] };
}
