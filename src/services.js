import {
  addEvent,
  countsByFormat,
  moveEvent,
  normalizeNum,
  normalizeSchedule,
  renumberEvents,
  removeEvent,
  updateEvent,
  validateEventField,
} from './schedule.js';
import {
  countNewRequests,
  createRequest,
  findRequest,
  listRequests,
  normalizeRequests,
  removeRequest,
  setRequestStatus,
} from './requests.js';

/**
 * Сервис расписания: читает, нормализует и меняет мероприятия.
 * Ничего не знает про файлы и базу — только про интерфейс store.
 */
export function createScheduleService({ store, logger }) {
  async function getSchedule() {
    return normalizeSchedule(await store.read());
  }

  async function mutate(updater) {
    let outcome = null;
    await store.update((raw) => {
      outcome = updater(normalizeSchedule(raw));
      return outcome.schedule;
    });
    return outcome;
  }

  return {
    getSchedule,

    async add(format, fields) {
      const outcome = await mutate((schedule) => addEvent(schedule, format, fields));
      logger.info(`Добавлено мероприятие ${format}: ${outcome.event.dates} — ${outcome.event.title}`);
      return outcome;
    },

    async update(format, index, field, value) {
      let patch;
      if (field === 'num') {
        const num = normalizeNum(value);
        if (!num) return { ok: false, error: 'Номер — это до трёх цифр, например 11.' };
        patch = { num };
      } else {
        const validation = validateEventField(field, value);
        if (!validation.ok) return { ok: false, error: validation.error };
        patch = { [field]: validation.value };
      }
      const outcome = await mutate((schedule) => updateEvent(schedule, format, index, patch));
      logger.info(`Изменено мероприятие ${format}#${index}: ${field}`);
      return { ok: true, ...outcome };
    },

    async updatePatch(format, index, patch) {
      const outcome = await mutate((schedule) => updateEvent(schedule, format, index, patch));
      return outcome;
    },

    async remove(format, index) {
      const outcome = await mutate((schedule) => removeEvent(schedule, format, index));
      logger.info(`Удалено мероприятие ${format}#${index}: ${outcome.removed?.dates ?? ''}`);
      return outcome;
    },

    async move(format, index, direction) {
      let moved = false;
      let reason = '';
      const outcome = await mutate((schedule) => {
        const result = moveEvent(schedule, format, index, direction);
        moved = result.moved;
        reason = result.reason ?? '';
        return result;
      });
      return { ...outcome, moved, reason };
    },

    async renumber(format) {
      const outcome = await mutate((schedule) => renumberEvents(schedule, format));
      logger.info(`Мероприятия ${format} перенумерованы.`);
      return outcome;
    },

    async stats() {
      const schedule = await getSchedule();
      return { schedule, counts: countsByFormat(schedule) };
    },
  };
}

/** Сервис заявок на гипнотерапию. */
export function createRequestService({ store, logger }) {
  async function read() {
    return normalizeRequests(await store.read());
  }

  return {
    async totals() {
      const data = await read();
      return { total: data.items.length, new: countNewRequests(data) };
    },

    async page(page = 1, perPage = 5) {
      return listRequests(await read(), { page, perPage });
    },

    async get(id) {
      return findRequest(await read(), id);
    },

    async create(value, options) {
      let request = null;
      await store.update((raw) => {
        const result = createRequest(normalizeRequests(raw), value, options);
        request = result.request;
        return result.data;
      });
      logger.info(`Новая заявка #${request.id} (${request.topic}) от ${request.name}`);
      return request;
    },

    async setStatus(id, status) {
      let request = null;
      await store.update((raw) => {
        const result = setRequestStatus(normalizeRequests(raw), id, status);
        request = result.request;
        return result.data;
      });
      return request;
    },

    async remove(id) {
      let removed = null;
      await store.update((raw) => {
        const result = removeRequest(normalizeRequests(raw), id);
        removed = result.removed;
        return result.data;
      });
      return removed;
    },
  };
}
