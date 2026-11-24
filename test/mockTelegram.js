import http from 'node:http';

/**
 * Мини-сервер Telegram Bot API для тестов: запоминает вызовы и отвечает
 * так же, как настоящий api.telegram.org (формат {ok:true,result}).
 */
export async function startMockTelegram() {
  const calls = [];
  let messageId = 1000;

  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;

    const url = new URL(request.url, 'http://127.0.0.1');
    const method = url.pathname.split('/').filter(Boolean).pop() || '';
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw };
      }
    }

    let result = true;
    if (method === 'getMe') {
      result = { id: 777000111, is_bot: true, first_name: 'Test', username: 'test_bot' };
    } else if (method === 'sendMessage') {
      result = {
        message_id: ++messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: 'private' },
        text: payload.text,
      };
    } else if (method === 'editMessageText') {
      result = {
        message_id: payload.message_id,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: 'private' },
        text: payload.text,
      };
    }

    calls.push({ method, payload, result });

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    get messages() {
      return calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText');
    },
    last(method) {
      const filtered = calls.filter((call) => call.method === method);
      return filtered[filtered.length - 1];
    },
    texts() {
      return this.messages.map((call) => call.payload.text ?? call.result?.text ?? '');
    },
    reset() {
      calls.length = 0;
    },
    close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      return closed;
    },
  };
}

export function textUpdate(id, text, userId = 42, chatId = userId) {
  const update = {
    update_id: id,
    message: {
      message_id: 10_000 + id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Admin' },
      text,
    },
  };
  if (text.startsWith('/')) {
    update.message.entities = [{ type: 'bot_command', offset: 0, length: text.length }];
  }
  return update;
}

export function callbackUpdate(id, data, messageId = 500, userId = 42, chatId = userId) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: userId, is_bot: false, first_name: 'Admin' },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        text: 'menu',
      },
      chat_instance: 'test-instance',
      data,
    },
  };
}
