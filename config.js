/**
 * Настройки сайта.
 *
 * apiBase  — адрес сервера, на котором работает бот и API.
 *            Для бесплатного варианта на Cloudflare это адрес воркера:
 *            "https://allareg-bot.ваш-аккаунт.workers.dev" (без слэша в конце).
 *            Если оставить пустым, сайт возьмёт расписание из schedule.json
 *            рядом с index.html, а форма попробует отправить заявку на тот же домен.
 * telegram — необязательная ссылка на Telegram. Показывается в форме,
 *            если отправить заявку не удалось. Например: "https://t.me/username".
 */
window.SITE_CONFIG = {
  apiBase: 'https://allareg-bot.den539321.workers.dev',
  telegram: '',
};
