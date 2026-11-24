export const FORMAT_KEYS = ['onsite', 'online'];

export const FORMATS = {
  onsite: { label: 'Очно · Оренбург', short: 'Очно' },
  online: { label: 'Онлайн', short: 'Онлайн' },
};

export const LIMITS = { dates: 120, title: 160, num: 3 };

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function cleanText(value, maxLength = Infinity) {
  const text = String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return text.slice(0, maxLength);
}

export function padNum(value) {
  return String(value).padStart(2, '0');
}

export function normalizeNum(value) {
  const digits = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(digits)) return '';
  return padNum(Number.parseInt(digits, 10));
}

export function emptySchedule() {
  return { onsite: [], online: [] };
}

/** Приводит любой входной JSON к строгой структуре расписания. */
export function normalizeSchedule(raw) {
  const result = emptySchedule();
  for (const format of FORMAT_KEYS) {
    const list = Array.isArray(raw?.[format]) ? raw[format] : [];
    result[format] = list
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        num: normalizeNum(item.num) || padNum(index + 1),
        dates: cleanText(item.dates, LIMITS.dates),
        title: cleanText(item.title, LIMITS.title),
      }))
      .filter((item) => item.dates || item.title);
  }
  return result;
}

export function assertFormat(format) {
  if (!FORMAT_KEYS.includes(format)) throw new Error(`Неизвестный формат: ${format}`);
  return format;
}

export function listEvents(schedule, format) {
  return schedule[assertFormat(format)] ?? [];
}

export function nextNum(schedule, format) {
  const events = listEvents(schedule, format);
  if (events.length === 0) return '01';
  const max = events.reduce((acc, item) => {
    const parsed = Number.parseInt(item.num, 10);
    return Number.isFinite(parsed) ? Math.max(acc, parsed) : acc;
  }, 0);
  return padNum(max + 1);
}

export function addEvent(schedule, format, { num, dates, title }) {
  assertFormat(format);
  const events = listEvents(schedule, format);
  const event = {
    num: normalizeNum(num) || nextNum(schedule, format),
    dates: cleanText(dates, LIMITS.dates),
    title: cleanText(title, LIMITS.title),
  };
  const next = { ...schedule, [format]: [...events, event] };
  return { schedule: next, event, index: events.length };
}

export function updateEvent(schedule, format, index, patch) {
  const events = [...listEvents(schedule, format)];
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    throw new RangeError('Мероприятие не найдено');
  }
  const current = events[index];
  const updated = { ...current };
  if (patch.dates !== undefined) updated.dates = cleanText(patch.dates, LIMITS.dates);
  if (patch.title !== undefined) updated.title = cleanText(patch.title, LIMITS.title);
  if (patch.num !== undefined) updated.num = normalizeNum(patch.num) || current.num;
  events[index] = updated;
  return { schedule: { ...schedule, [format]: events }, event: updated };
}

export function removeEvent(schedule, format, index) {
  const events = [...listEvents(schedule, format)];
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    throw new RangeError('Мероприятие не найдено');
  }
  const [removed] = events.splice(index, 1);
  return { schedule: { ...schedule, [format]: events }, removed };
}

/** Сдвигает мероприятие на одну позицию: direction = -1 (выше) или 1 (ниже). */
export function moveEvent(schedule, format, index, direction) {
  const events = [...listEvents(schedule, format)];
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    throw new RangeError('Мероприятие не найдено');
  }
  const target = index + direction;
  if (target < 0 || target >= events.length) {
    return {
      schedule,
      moved: false,
      reason: direction < 0 ? 'Это первое мероприятие' : 'Это последнее мероприятие',
    };
  }
  [events[index], events[target]] = [events[target], events[index]];
  return { schedule: { ...schedule, [format]: events }, moved: true };
}

/** Перенумеровывает список: 01, 02, 03 … */
export function renumberEvents(schedule, format) {
  const events = listEvents(schedule, format).map((item, index) => ({ ...item, num: padNum(index + 1) }));
  return { schedule: { ...schedule, [format]: events } };
}

export function countsByFormat(schedule) {
  return {
    onsite: listEvents(schedule, 'onsite').length,
    online: listEvents(schedule, 'online').length,
  };
}

/** Проверка текста, который администратор присылает боту. */
export function validateEventField(field, value) {
  const limit = field === 'dates' ? LIMITS.dates : LIMITS.title;
  const cleaned = cleanText(value);
  if (!cleaned) {
    return { ok: false, error: field === 'dates' ? 'Даты не могут быть пустыми.' : 'Название не может быть пустым.' };
  }
  if (cleaned.length > limit) {
    return { ok: false, error: `Слишком длинно: максимум ${limit} символов.` };
  }
  return { ok: true, value: cleaned };
}

/** Разбор номера мероприятия, введённого вручную. */
export function validateNumberInput(value, schedule, format) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-' || raw === '—') {
    return { ok: true, value: nextNum(schedule, format), auto: true };
  }
  if (!/^\d{1,3}$/.test(raw)) {
    return {
      ok: false,
      error: 'Номер — это до трёх цифр, например 11. Отправьте «-», чтобы присвоить следующий.',
    };
  }
  return { ok: true, value: padNum(Number.parseInt(raw, 10)), auto: false };
}
