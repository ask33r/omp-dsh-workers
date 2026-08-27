/**
 * Снос временного каталога кейса, устойчивый к «мост ещё дописывает реестр».
 *
 * Почему не голый `rm(dir, { recursive: true, force: true })`:
 *
 * waitRun/pollRun считают ран завершённым по envelope на диске и по мёртвому
 * pid — и это осознанно: поле state в реестре может протухнуть. Но обработчик
 * `child.once('close')` в async-run.js после этого ещё доделывает бухгалтерию
 * рана: finalizeIfAbsent + putRun, а putRun пишет атомарно — сначала
 * `runs.json.tmp.<uuid>` рядом, потом rename в `runs.json`.
 *
 * То есть после возврата из waitRun каталог рана какое-то время ещё ЖИВОЙ:
 * в него прилетают новые файлы. Если тест в этот момент сносит каталог,
 * fs.rm успевает вычистить содержимое, мост создаёт файл заново — и финальный
 * rmdir падает с ENOTEMPTY.
 *
 * `force: true` здесь не помогает: он гасит только ENOENT, а не ENOTEMPTY.
 * Ретраи — штатный механизм fs.rm ровно для ENOTEMPTY/EBUSY/EPERM: они дают
 * досылке моста добежать. На чистом пути (гонки не было) не стоят ни одной
 * лишней миллисекунды — ретрай случается только по факту ошибки.
 *
 * Замеры (node 22, ограниченный писатель — точная модель обработчика close):
 * без ретраев 20/20 ENOTEMPTY, с ретраями 0/20. Под bun гонки нет вовсе:
 * его `fs.rm` крутит удаление, пока каталог реально не опустеет, — поэтому
 * правка нужна только node-набору (`test:bridge`), а не bun-тестам.
 */
import { rm } from 'node:fs/promises';

/** Ретраи fs.rm: линейный backoff 50, 100, ... 500 мс — суммарно до ~2.75 с. */
const RM_RETRIES = 10;
const RM_RETRY_DELAY_MS = 50;

/**
 * @param {string} dir каталог кейса
 * @returns {Promise<void>}
 */
export function rmTestDir(dir) {
  return rm(dir, {
    recursive: true,
    force: true,
    maxRetries: RM_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
}
