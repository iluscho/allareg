function parseValue(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * JSON-документ в D1: интерфейс такой же, как у JsonStore из Node-версии.
 * Оптимистичная блокировка по колонке version не даёт двум одновременным
 * нажатиям в боте перетереть изменения друг друга.
 */
export class D1JsonStore {
  constructor(db, key, fallback = null) {
    this.db = db;
    this.key = key;
    this.fallback = fallback;
  }

  async read() {
    const row = await this.db.prepare('SELECT value FROM state WHERE key = ?').bind(this.key).first();
    if (!row) return null;
    return parseValue(row.value, null);
  }

  async write(value) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO state (key, value, version, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = state.version + 1, updated_at = excluded.updated_at`,
      )
      .bind(this.key, JSON.stringify(value), now)
      .run();
    return value;
  }

  async update(updater) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const row = await this.db.prepare('SELECT value, version FROM state WHERE key = ?').bind(this.key).first();
      const version = row ? Number(row.version) : 0;
      const current = row ? parseValue(row.value, this.fallback) : structuredClone(this.fallback);
      const next = await updater(current);
      const now = new Date().toISOString();

      const result = await this.db
        .prepare(
          `INSERT INTO state (key, value, version, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = state.version + 1, updated_at = excluded.updated_at
           WHERE state.version = ?`,
        )
        .bind(this.key, JSON.stringify(next), now, version)
        .run();

      const changes = result?.meta?.changes ?? result?.changes ?? 0;
      if (changes === 1) return next;

      // Кто-то успел записать раньше — небольшая пауза и повторное чтение.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 25));
    }

    throw new Error('Не удалось сохранить данные: одновременное изменение. Попробуйте ещё раз.');
  }
}
