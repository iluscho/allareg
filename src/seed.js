import fs from 'node:fs/promises';

import { emptySchedule, normalizeSchedule } from './schedule.js';

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * При первом запуске переносит расписание из schedule.json сайта в хранилище.
 * Только для Node-версии: в Cloudflare Workers расписание засевается из бандла.
 */
export async function seedScheduleIfNeeded({ store, seedPath, logger }) {
  if (await fileExists(store.file)) return false;
  try {
    const raw = JSON.parse(await fs.readFile(seedPath, 'utf8'));
    const schedule = normalizeSchedule(raw);
    await store.write(schedule);
    logger.info(
      `Расписание создано из ${seedPath}: очно — ${schedule.onsite.length}, онлайн — ${schedule.online.length}`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`Не удалось прочитать ${seedPath}: ${error.message}`);
    await store.write(emptySchedule());
    logger.warn('Создано пустое расписание.');
  }
  return true;
}
