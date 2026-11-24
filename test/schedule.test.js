import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEvent,
  cleanText,
  countsByFormat,
  emptySchedule,
  moveEvent,
  nextNum,
  normalizeSchedule,
  normalizeNum,
  renumberEvents,
  removeEvent,
  updateEvent,
  validateEventField,
  validateNumberInput,
} from '../src/schedule.js';

test('normalizeSchedule приводит данные к строгой структуре', () => {
  const result = normalizeSchedule({
    onsite: [{ dates: '  12–13 декабря 2026 ', title: 'Эриксоновский  гипноз' }, null, { dates: '', title: '' }],
    online: 'не массив',
    лишнее: [],
  });

  assert.deepEqual(result.onsite, [
    { num: '01', dates: '12–13 декабря 2026', title: 'Эриксоновский гипноз' },
  ]);
  assert.deepEqual(result.online, []);
  assert.deepEqual(Object.keys(result).sort(), ['online', 'onsite']);
});

test('normalizeSchedule сохраняет существующую нумерацию', () => {
  const result = normalizeSchedule({ onsite: [{ num: '7', dates: 'дата', title: 'тема' }] });
  assert.equal(result.onsite[0].num, '07');
});

test('normalizeNum принимает только цифры', () => {
  assert.equal(normalizeNum('3'), '03');
  assert.equal(normalizeNum(' 12 '), '12');
  assert.equal(normalizeNum('11a'), '');
  assert.equal(normalizeNum('1234'), '');
});

test('cleanText убирает лишние пробелы и управляющие символы', () => {
  assert.equal(cleanText('  а\n\n б  '), 'а б');
  assert.equal(cleanText('x\u0000y'), 'xy');
  assert.equal(cleanText('abcdef', 3), 'abc');
});

test('addEvent добавляет мероприятие в конец и нумерует автоматически', () => {
  const schedule = emptySchedule();
  const first = addEvent(schedule, 'onsite', { dates: '1 января', title: 'Первое' });
  assert.equal(first.event.num, '01');
  assert.equal(first.schedule.onsite.length, 1);

  const second = addEvent(first.schedule, 'onsite', { dates: '2 января', title: 'Второе' });
  assert.equal(second.event.num, '02');
  assert.equal(second.index, 1);
  assert.equal(second.schedule.online.length, 0);
});

test('nextNum учитывает максимальный номер, а не количество', () => {
  const schedule = { onsite: [{ num: '05', dates: 'a', title: 'b' }], online: [] };
  assert.equal(nextNum(schedule, 'onsite'), '06');
  assert.equal(nextNum(schedule, 'online'), '01');
});

test('updateEvent меняет только переданные поля', () => {
  const schedule = { onsite: [{ num: '01', dates: 'старая дата', title: 'старое имя' }], online: [] };
  const result = updateEvent(schedule, 'onsite', 0, { title: 'новое имя' });
  assert.deepEqual(result.event, { num: '01', dates: 'старая дата', title: 'новое имя' });
  assert.equal(schedule.onsite[0].title, 'старое имя', 'исходные данные не мутируются');
});

test('updateEvent бросает ошибку для несуществующего индекса', () => {
  assert.throws(() => updateEvent(emptySchedule(), 'onsite', 3, { title: 'x' }), RangeError);
});

test('removeEvent удаляет по индексу и не перенумеровывает', () => {
  const schedule = {
    onsite: [
      { num: '01', dates: 'a', title: 'A' },
      { num: '02', dates: 'b', title: 'B' },
      { num: '03', dates: 'c', title: 'C' },
    ],
    online: [],
  };
  const result = removeEvent(schedule, 'onsite', 1);
  assert.deepEqual(result.removed.title, 'B');
  assert.deepEqual(result.schedule.onsite.map((item) => item.num), ['01', '03']);
});

test('moveEvent двигает мероприятие и сообщает о краях списка', () => {
  const schedule = {
    onsite: [
      { num: '01', dates: 'a', title: 'A' },
      { num: '02', dates: 'b', title: 'B' },
    ],
    online: [],
  };

  const down = moveEvent(schedule, 'onsite', 0, 1);
  assert.equal(down.moved, true);
  assert.deepEqual(down.schedule.onsite.map((item) => item.title), ['B', 'A']);

  const edge = moveEvent(schedule, 'onsite', 0, -1);
  assert.equal(edge.moved, false);
  assert.match(edge.reason, /первое/i);
});

test('renumberEvents выставляет номера по порядку', () => {
  const schedule = {
    onsite: [
      { num: '05', dates: 'a', title: 'A' },
      { num: '09', dates: 'b', title: 'B' },
    ],
    online: [],
  };
  const result = renumberEvents(schedule, 'onsite');
  assert.deepEqual(result.schedule.onsite.map((item) => item.num), ['01', '02']);
});

test('countsByFormat считает оба списка', () => {
  const counts = countsByFormat({
    onsite: [{ dates: 'a', title: 'b' }],
    online: [{ dates: 'a', title: 'b' }, { dates: 'c', title: 'd' }],
  });
  assert.deepEqual(counts, { onsite: 1, online: 2 });
});

test('validateEventField проверяет обязательность и длину', () => {
  assert.deepEqual(validateEventField('dates', '  '), { ok: false, error: 'Даты не могут быть пустыми.' });
  assert.deepEqual(validateEventField('title', ''), { ok: false, error: 'Название не может быть пустым.' });

  const long = 'а'.repeat(200);
  assert.equal(validateEventField('title', long).ok, false);

  const ok = validateEventField('title', '  Прошлые   жизни ');
  assert.deepEqual(ok, { ok: true, value: 'Прошлые жизни' });
});

test('validateNumberInput понимает «-» как автономер', () => {
  const schedule = emptySchedule();
  assert.deepEqual(validateNumberInput('-', schedule, 'onsite'), { ok: true, value: '01', auto: true });
  assert.deepEqual(validateNumberInput('12', schedule, 'onsite'), { ok: true, value: '12', auto: false });
  assert.equal(validateNumberInput('12a', schedule, 'onsite').ok, false);
});
