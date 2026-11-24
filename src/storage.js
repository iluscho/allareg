import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Простейшее JSON-хранилище с атомарной записью и очередью операций.
 * Данных мало (десятки мероприятий и заявок), поэтому файла достаточно —
 * база данных не нужна.
 */
export class JsonStore {
  #file;
  #fallback;
  #queue = Promise.resolve();

  constructor(file, fallbackValue) {
    this.#file = file;
    this.#fallback = fallbackValue;
  }

  get file() {
    return this.#file;
  }

  async read() {
    let raw;
    try {
      raw = await fs.readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.#fallback);
      throw error;
    }
    if (!raw.trim()) return structuredClone(this.#fallback);
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Файл ${this.#file} повреждён: ${error.message}`);
    }
  }

  async write(value) {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.#file);
    return value;
  }

  /**
   * Атомарно «прочитать → изменить → записать».
   * Изменения выполняются строго по очереди, поэтому одновременные
   * нажатия кнопок в боте не перетирают друг друга.
   */
  async update(updater) {
    const run = async () => {
      const current = await this.read();
      const next = await updater(current);
      return this.write(next);
    };
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }
}
