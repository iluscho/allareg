import { cleanText } from './schedule.js';

export const TOPICS = {
  therapy: 'Гипнотерапия · индивидуальная сессия',
  course: 'Обучение на программе',
  other: 'Другой вопрос',
};

export const TOPIC_KEYS = Object.keys(TOPICS);

export const REQUEST_LIMITS = {
  name: 80,
  contact: 120,
  message: 1500,
  preferredTime: 80,
};

const STATUSES = ['new', 'done'];

export function emptyRequests() {
  return { nextId: 1, items: [] };
}

function cleanMultiline(value, maxLength) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, maxLength);
}

export function topicLabel(topic) {
  return TOPICS[topic] ?? TOPICS.other;
}

/** Приводит файл заявок к ожидаемой структуре (на случай ручной правки). */
export function normalizeRequests(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const normalized = items
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: Number.isInteger(item.id) && item.id > 0 ? item.id : index + 1,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      name: cleanText(item.name, REQUEST_LIMITS.name),
      contact: cleanText(item.contact, REQUEST_LIMITS.contact),
      topic: TOPIC_KEYS.includes(item.topic) ? item.topic : 'other',
      topicLabel: topicLabel(item.topic),
      message: cleanMultiline(item.message, REQUEST_LIMITS.message),
      preferredTime: cleanText(item.preferredTime, REQUEST_LIMITS.preferredTime),
      status: STATUSES.includes(item.status) ? item.status : 'new',
      source: item.source === 'bot' ? 'bot' : 'site',
    }));
  const maxId = normalized.reduce((acc, item) => Math.max(acc, item.id), 0);
  const nextId = Number.isInteger(raw?.nextId) ? Math.max(raw.nextId, maxId + 1) : maxId + 1;
  return { nextId, items: normalized };
}

/** Проверка данных формы с сайта. Возвращает русские тексты ошибок для полей. */
export function validateRequestPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const errors = {};

  const name = cleanText(source.name);
  if (name.length < 2) errors.name = 'Укажите имя — минимум 2 символа.';
  else if (name.length > REQUEST_LIMITS.name) errors.name = `Имя слишком длинное (максимум ${REQUEST_LIMITS.name} символов).`;

  const contact = cleanText(source.contact);
  if (contact.length < 3) errors.contact = 'Оставьте телефон или ник в Telegram для связи.';
  else if (contact.length > REQUEST_LIMITS.contact) errors.contact = `Контакт слишком длинный (максимум ${REQUEST_LIMITS.contact} символов).`;

  const topic = String(source.topic ?? '').trim() || 'other';
  if (!TOPIC_KEYS.includes(topic)) errors.topic = 'Выберите тему обращения из списка.';

  const message = cleanMultiline(source.message, Infinity);
  if (message.length > REQUEST_LIMITS.message) errors.message = `Текст слишком длинный (максимум ${REQUEST_LIMITS.message} символов).`;

  const preferredTime = cleanText(source.preferredTime);
  if (preferredTime.length > REQUEST_LIMITS.preferredTime) errors.preferredTime = 'Слишком длинный текст.';

  const consent = source.consent === true || source.consent === 'true' || source.consent === 'on' || source.consent === 1;
  if (!consent) errors.consent = 'Нужно согласие на обработку персональных данных.';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { name, contact, topic, message, preferredTime },
  };
}

export function createRequest(data, value, { source = 'site' } = {}) {
  const request = {
    id: data.nextId,
    createdAt: new Date().toISOString(),
    name: value.name,
    contact: value.contact,
    topic: value.topic,
    topicLabel: topicLabel(value.topic),
    message: value.message ?? '',
    preferredTime: value.preferredTime ?? '',
    status: 'new',
    source,
  };
  return {
    data: { nextId: data.nextId + 1, items: [...data.items, request] },
    request,
  };
}

export function findRequest(data, id) {
  return data.items.find((item) => item.id === id) ?? null;
}

export function setRequestStatus(data, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`Неизвестный статус: ${status}`);
  const items = data.items.map((item) => (item.id === id ? { ...item, status } : item));
  return { data: { ...data, items }, request: items.find((item) => item.id === id) ?? null };
}

export function removeRequest(data, id) {
  const target = findRequest(data, id);
  if (!target) return { data, removed: null };
  return { data: { ...data, items: data.items.filter((item) => item.id !== id) }, removed: target };
}

export function countNewRequests(data) {
  return data.items.filter((item) => item.status === 'new').length;
}

/** Заявки в обратном хронологическом порядке с постраничной выдачей. */
export function listRequests(data, { page = 1, perPage = 5 } = {}) {
  const sorted = [...data.items].sort((a, b) => b.id - a.id);
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * perPage;
  return {
    items: sorted.slice(start, start + perPage),
    total: sorted.length,
    page: safePage,
    pages,
  };
}
