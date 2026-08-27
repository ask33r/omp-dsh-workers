import { isSafePgid, isSafePid } from '../src/registry.js';

/**
 * Безопасный kill для cleanup-кода тестов.
 *
 * ПОЧЕМУ не `process.kill` напрямую: продовый код ходит через killPgid/killPid,
 * которые отсекают pgid/pid <= 1 и собственную группу, а тестовый cleanup эти
 * гарды обходил. На настоящем pid это незаметно, но стоит подставить фикстуру с
 * `pgid: 1` (ровно то, что отдаёт утёкший mock.module из bun-тестов
 * extensions), как `process.kill(-1, SIGKILL)` превращается в BROADCAST всем
 * процессам пользователя и сносит контейнер целиком.
 *
 * Гарды не дублируем — импортируем те же isSafePgid/isSafePid из src/registry.js,
 * чтобы у теста и у прода не могло разъехаться понятие «безопасный номер».
 */

function warnUnsafe(kind, value) {
  process.stderr.write(
    `[kill-safe] отказ: небезопасный ${kind}=${String(value)} — сигнал НЕ отправлен. ` +
      'Обычно это признак утёкшего mock.module (запуск через голый `bun test`).\n',
  );
}

function signal(target, sig) {
  try {
    process.kill(target, sig);
    return true;
  } catch (err) {
    // ESRCH — процесс уже мёртв; для cleanup это штатный исход, а не проблема.
    if (err?.code !== 'ESRCH') {
      process.stderr.write(`[kill-safe] kill(${target}, ${sig}) failed: ${err?.code ?? err?.message ?? err}\n`);
    }
    return false;
  }
}

/**
 * Глушит тестовую фикстуру: сначала группу (детач-процессы плодят детей),
 * затем сам pid. Никогда не бросает — вызывается из finally, где исключение
 * затёрло бы настоящую причину падения теста.
 *
 * @param {number|undefined} pid   pid фикстуры; undefined/null — пропустить
 * @param {number|undefined} pgid  process group; undefined/null — пропустить
 * @param {NodeJS.Signals} [sig]   сигнал, по умолчанию SIGKILL (cleanup добивает)
 * @returns {boolean} был ли реально отправлен хоть один сигнал
 */
export function killTestProcess(pid, pgid, sig = 'SIGKILL') {
  let sent = false;

  if (pgid !== undefined && pgid !== null) {
    if (isSafePgid(pgid)) {
      if (signal(-pgid, sig)) sent = true;
    } else {
      warnUnsafe('pgid', pgid);
    }
  }

  if (pid !== undefined && pid !== null) {
    if (isSafePid(pid)) {
      if (signal(pid, sig)) sent = true;
    } else {
      warnUnsafe('pid', pid);
    }
  }

  return sent;
}
