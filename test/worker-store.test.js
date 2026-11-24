import assert from 'node:assert/strict';
import test from 'node:test';

import { D1PendingStore } from '../worker/pendingStore.js';
import { D1JsonStore } from '../worker/store.js';
import { createD1Shim } from './d1Shim.js';

test('D1JsonStore: нет данных — null, после записи читается', async (t) => {
  const db = createD1Shim();
  t.after(() => db.close());
  const store = new D1JsonStore(db, 'schedule', { onsite: [], online: [] });

  assert.equal(await store.read(), null);

  await store.write({ onsite: [{ num: '01', dates: 'дата', title: 'тема' }], online: [] });
  assert.deepEqual((await store.read()).onsite[0].title, 'тема');
});

test('D1JsonStore: параллельные обновления не теряют изменения', async (t) => {
  const db = createD1Shim();
  t.after(() => db.close());
  const store = new D1JsonStore(db, 'counter', { value: 0 });
  await store.write({ value: 0 });

  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.update((current) => {
        current.value += 1;
        return current;
      }),
    ),
  );

  assert.equal((await store.read()).value, 12);
});

test('D1JsonStore: update создаёт документ, если его не было', async (t) => {
  const db = createD1Shim();
  t.after(() => db.close());
  const store = new D1JsonStore(db, 'requests', { nextId: 1, items: [] });

  const result = await store.update((current) => ({ ...current, nextId: 5 }));
  assert.equal(result.nextId, 5);
  assert.equal((await store.read()).nextId, 5);
});

test('D1PendingStore: сохраняет, читает и убирает состояние', async (t) => {
  const db = createD1Shim();
  t.after(() => db.close());
  const store = new D1PendingStore(db);

  assert.equal(await store.get('42'), null);

  await store.set('42', { kind: 'add', step: 'dates', expiresAt: Date.now() + 60_000 });
  assert.equal((await store.get('42')).step, 'dates');

  await store.remove('42');
  assert.equal(await store.get('42'), null);
});

test('D1PendingStore: просроченный ввод не возвращается', async (t) => {
  const db = createD1Shim();
  t.after(() => db.close());
  const store = new D1PendingStore(db);

  await store.set('42', { kind: 'add', step: 'dates', expiresAt: Date.now() - 1_000 });
  assert.equal(await store.get('42'), null);
});
