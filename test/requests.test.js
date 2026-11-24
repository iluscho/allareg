import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countNewRequests,
  createRequest,
  emptyRequests,
  listRequests,
  normalizeRequests,
  removeRequest,
  setRequestStatus,
  validateRequestPayload,
} from '../src/requests.js';

test('валидная заявка проходит проверку', () => {
  const result = validateRequestPayload({
    name: '  Анна ',
    contact: ' +7 900 000-00-00 ',
    topic: 'therapy',
    message: 'Хочу на сессию',
    preferredTime: 'после 18:00',
    consent: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    name: 'Анна',
    contact: '+7 900 000-00-00',
    topic: 'therapy',
    message: 'Хочу на сессию',
    preferredTime: 'после 18:00',
  });
});

test('заявка без имени, контакта и согласия не проходит', () => {
  const result = validateRequestPayload({ name: ' ', contact: '', consent: false });
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), ['consent', 'contact', 'name']);
});

test('тема по умолчанию — «другой вопрос»', () => {
  const result = validateRequestPayload({ name: 'Анна', contact: '@anna', consent: true });
  assert.equal(result.value.topic, 'other');
});

test('неизвестная тема отклоняется', () => {
  const result = validateRequestPayload({ name: 'Анна', contact: '@anna', topic: 'hack', consent: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.topic);
});

test('слишком длинное сообщение отклоняется', () => {
  const result = validateRequestPayload({ name: 'Анна', contact: '@anna', message: 'а'.repeat(1600), consent: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.message);
});

test('createRequest увеличивает счётчик и сохраняет поля', () => {
  const { data, request } = createRequest(emptyRequests(), {
    name: 'Анна',
    contact: '@anna',
    topic: 'therapy',
    message: 'текст',
    preferredTime: '',
  });

  assert.equal(request.id, 1);
  assert.equal(request.status, 'new');
  assert.equal(request.topicLabel, 'Гипнотерапия · индивидуальная сессия');
  assert.equal(data.nextId, 2);
  assert.equal(data.items.length, 1);
});

test('listRequests отдаёт новые сверху и делит на страницы', () => {
  let data = emptyRequests();
  for (let index = 1; index <= 7; index += 1) {
    data = createRequest(data, { name: `Гость ${index}`, contact: `@g${index}`, topic: 'other' }).data;
  }

  const first = listRequests(data, { page: 1, perPage: 5 });
  assert.equal(first.total, 7);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.items.map((item) => item.id), [7, 6, 5, 4, 3]);

  const second = listRequests(data, { page: 2, perPage: 5 });
  assert.deepEqual(second.items.map((item) => item.id), [2, 1]);
});

test('статус меняется и заявка удаляется', () => {
  const created = createRequest(emptyRequests(), { name: 'Анна', contact: '@anna', topic: 'therapy' });
  const done = setRequestStatus(created.data, 1, 'done');
  assert.equal(done.request.status, 'done');
  assert.equal(countNewRequests(done.data), 0);

  const removed = removeRequest(done.data, 1);
  assert.equal(removed.removed.name, 'Анна');
  assert.equal(removed.data.items.length, 0);
});

test('normalizeRequests восстанавливает файл после ручной правки', () => {
  const data = normalizeRequests({
    items: [{ id: 5, name: 'Анна', contact: '@anna', topic: 'therapy', status: 'unknown' }],
  });
  assert.equal(data.items[0].status, 'new');
  assert.equal(data.nextId, 6);
});
