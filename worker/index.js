import { createWorkerApp } from './app.js';

/**
 * Cloudflare Workers создаёт изоляты по своему усмотрению, поэтому готовое
 * приложение (а вместе с ним инициализированный бот и кэш вебхука) держим
 * в памяти изолята и пересоздаём только при смене токена.
 */
let cached = null;

export default {
  async fetch(request, env, ctx) {
    if (!cached || cached.token !== env.BOT_TOKEN) {
      cached = { token: env.BOT_TOKEN, app: createWorkerApp(env) };
    }
    return cached.app.fetch(request, env, ctx);
  },
};
