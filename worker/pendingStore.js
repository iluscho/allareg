import { PENDING_TTL_MS } from '../src/botCore.js';

/** Незавершённый ввод в D1: переживает холодный старт и переключение изолятов. */
export class D1PendingStore {
  constructor(db) {
    this.db = db;
  }

  async get(chatId) {
    const row = await this.db
      .prepare('SELECT data, expires_at FROM pending WHERE chat_id = ?')
      .bind(String(chatId))
      .first();
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      await this.remove(chatId);
      return null;
    }
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  async set(chatId, value) {
    const expiresAt = Number(value?.expiresAt) || Date.now() + PENDING_TTL_MS;
    await this.db
      .prepare(
        `INSERT INTO pending (chat_id, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      )
      .bind(String(chatId), JSON.stringify(value), expiresAt)
      .run();
  }

  async remove(chatId) {
    await this.db.prepare('DELETE FROM pending WHERE chat_id = ?').bind(String(chatId)).run();
  }
}
