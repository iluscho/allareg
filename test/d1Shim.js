import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCHEMA = fs.readFileSync(fileURLToPath(new URL('../worker/schema.sql', import.meta.url)), 'utf8');

/**
 * Эмуляция D1 поверх встроенного node:sqlite.
 * Повторяет ровно тот набор методов, который использует worker/.
 */
export function createD1Shim() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...args) {
          params = args;
          return statement;
        },
        async first(column) {
          const row = db.prepare(sql).get(...params);
          if (!row) return null;
          return column ? row[column] : row;
        },
        async all() {
          return { results: db.prepare(sql).all(...params), success: true, meta: {} };
        },
        async run() {
          const info = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}
