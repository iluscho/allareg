import 'dotenv/config';

/**
 * Привязывает бота к Cloudflare Worker: сообщает Telegram адрес вебхука.
 *
 *   node scripts/set-webhook.mjs            # установить
 *   node scripts/set-webhook.mjs --delete   # удалить
 *
 * Нужны переменные в .env: BOT_TOKEN, WEBHOOK_URL, WEBHOOK_SECRET.
 *
 * Если api.telegram.org недоступен из вашей сети (частая ситуация в РФ),
 * скрипт автоматически попросит воркер настроить вебхук со стороны Cloudflare.
 */
const token = (process.env.BOT_TOKEN || '').trim();
const base = (process.env.WEBHOOK_URL || '').trim().replace(/\/+$/, '');
const secret = (process.env.WEBHOOK_SECRET || '').trim();
const remove = process.argv.includes('--delete');

if (!token) {
  console.error('Не задан BOT_TOKEN в .env');
  process.exit(1);
}
if (!base || !secret) {
  console.error('Нужны WEBHOOK_URL и WEBHOOK_SECRET (секрет тот же, что задан в Cloudflare).');
  process.exit(1);
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`${method}: ${data.description || response.status}`);
  }
  return data.result;
}

async function viaWorker(method) {
  const response = await fetch(`${base}/api/setup`, {
    method: method === 'deleteWebhook' ? 'DELETE' : 'POST',
    headers: { 'X-Setup-Token': secret },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`воркер: ${data.error || data.description || `HTTP ${response.status}`}`);
  }
  return data;
}

async function webhookInfo() {
  try {
    return await telegram('getWebhookInfo', {});
  } catch {
    const response = await fetch(`${base}/api/webhook-info`, {
      headers: { 'X-Setup-Token': secret },
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => ({}));
    return data.info ?? { error: data.error ?? data.description ?? `HTTP ${response.status}` };
  }
}

function printInfo(info) {
  console.log('Состояние вебхука:', {
    url: info.url || '(пусто)',
    pending_updates: info.pending_update_count ?? 0,
    last_error: info.last_error_message ?? null,
  });
}

if (remove) {
  let done = false;
  try {
    await telegram('deleteWebhook', { drop_pending_updates: false });
    done = true;
    console.log('Вебхук удалён напрямую через Telegram.');
  } catch (error) {
    console.warn(`Прямой доступ к Telegram недоступен (${error.message}), пробую через воркер…`);
  }
  if (!done) {
    await viaWorker('deleteWebhook');
    console.log('Вебхук удалён через воркер. Бот снова может работать через длинный polling.');
  }
  process.exit(0);
}

const url = `${base}/telegram/${secret}`;
let installed = false;

try {
  await telegram('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
  installed = true;
  console.log('Вебхук установлен напрямую через Telegram:', url);
} catch (error) {
  console.warn(`Прямой доступ к Telegram недоступен (${error.message}), настраиваю через воркер…`);
}

if (!installed) {
  const result = await viaWorker('setWebhook');
  console.log('Вебхук установлен через воркер:', result.url ?? url);
}

printInfo(await webhookInfo());
console.log('Проверьте бота в Telegram: /start, затем /id.');
