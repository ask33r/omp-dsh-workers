import { mkdir, readFile, writeFile, rename, unlink, open as fsOpen, stat as fsStat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// var/runs.json рядом с bridge (tools/dsh-bridge/var/runs.json)
export function getRegistryPath(override) {
  if (override) return override;
  // allow env override for tests
  if (process.env.DSH_BRIDGE_RUNS_FILE) return process.env.DSH_BRIDGE_RUNS_FILE;
  return join(__dirname, '..', 'var', 'runs.json');
}

/**
 * kill(2) footgun, из-за которого прогон тестов убивал всю сессию:
 *   kill(-1, sig)   -> сигнал ВСЕМ процессам пользователя (вся сессия, включая агента);
 *   kill(0|-0, sig) -> сигнал СВОЕЙ process group.
 * pgid в реестре приходит из данных (stale-запись, ручная правка, тестовая фикстура),
 * поэтому pgid <= 1 и собственная группа запрещены в хелперах, а не у вызывающих.
 */
function readOwnPgid() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    // после "(comm)" идут: state ppid pgrp ...
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(fields[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

const OWN_PGID = readOwnPgid();

export function isSafePgid(pgid) {
  if (typeof pgid !== 'number' || !Number.isInteger(pgid)) return false;
  if (pgid <= 1) return false; // -1 = broadcast, 0 = своя группа
  if (OWN_PGID !== null && pgid === OWN_PGID) return false; // не сносим собственную группу
  return true;
}

export function isSafePid(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return false;
  if (pid <= 1) return false; // 1 = init, 0 = своя группа
  return pid !== process.pid;
}

/**
 * Identity процесса против переиспользования PID (P1 кросс-ревью, дефект 3):
 * killRun/reapOrphans бьют по pid/pgid ИЗ РЕЕСТРА — если наш процесс успел
 * умереть, а ОС переиспользовала его номер раньше, чем реестр это заметил,
 * kill(2) улетит в совершенно чужой (живой, не имеющий отношения к нам)
 * процесс. Поле 22 из /proc/<pid>/stat (starttime — тики с момента загрузки
 * ядра) дешёво отличает «тот самый» процесс от «новый процесс с тем же
 * номером»: парсим ПОСЛЕ последней ')' точно так же, как readOwnPgid — comm
 * в скобках может содержать что угодно, включая пробелы и свои скобки.
 */
export function readProcStarttime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // после "(comm)" поля идут с №3 (state); starttime — поле №22 => индекс 22-3=19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = fields[19];
    return typeof starttime === 'string' && starttime !== '' ? starttime : null;
  } catch {
    return null;
  }
}

/**
 * true, если можно доверять, что pid из entry — тот же процесс, что мы сами
 * породили (или запись — старого формата, где procStarttime не писали вовсе:
 * тогда ведём себя как раньше, доверяя реестру без проверки — обратная
 * совместимость). Вызывающая сторона обязана звать это ТОЛЬКО когда pid уже
 * считается живым (isPidAlive) — иначе readProcStarttime(pid) закономерно
 * вернёт null (процесса нет) и результат будет false просто из-за смерти, а
 * не из-за подмены identity; для мёртвого pid сигнал и так никому не шлётся.
 */
export function isSameProcessAsRegistered(entry, pid) {
  const recorded = entry?.procStarttime;
  if (recorded === undefined || recorded === null) return true;
  const current = readProcStarttime(pid);
  return current !== null && current === recorded;
}

/** Убить process group. Отказывает на небезопасном pgid. */
export function killPgid(pgid, sig = 'SIGTERM') {
  if (!isSafePgid(pgid)) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Убить одиночный pid. Отказывает на небезопасном pid. */
export function killPid(pid, sig = 'SIGTERM') {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Межпроцессный лок реестра (P0 кросс-ревью, дефект 1): putRun/updateRun/
// removeRun/clearRegistry/reapOrphans — read-modify-write поверх runs.json.
// atomic tmp+rename защищает от ПОРЧИ файла при параллельной записи, но не от
// lost update: два процесса читают один и тот же снимок, каждый пишет СВОЙ
// результат целиком — кто записал последним, тот и победил, изменения первого
// пропадают молча. Лок сериализует всю пару read+write, а не только сам write.
//
// Без внешних зависимостей: fs.open(lock, 'wx') атомарен на уровне ОС (создаёт
// файл, только если его ещё нет) — ровно то же свойство, на котором держится
// tmp+rename ниже, только вместо переименования используем сам факт успешного
// создания как захват мьютекса.
const LOCK_STALE_MS = 10000; // лок старше этого — считаем, что владелец умер между open() и unlink()
const LOCK_TIMEOUT_MS = 2000; // общий бюджет ожидания чужого (живого) лока
const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 50;

/**
 * Токен владения локом: pid один не годится — release должен отличать «это
 * СВЕЖИЙ лок, который я сам только что захватил» от «лок с моим pid, который
 * я держал РАНЬШЕ, потом потерял (сочли протухшим, перехватили), а теперь тут
 * лежит чей-то ещё» (в общем случае — от чужого процесса, но uuid защищает и
 * от вырожденного совпадения pid). uuid делает каждый акт захвата уникальным.
 */
function makeLockToken() {
  return `${process.pid}:${randomUUID()}`;
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = LOCK_RETRY_MIN_MS;
  for (;;) {
    const token = makeLockToken();
    try {
      const fh = await fsOpen(lockPath, 'wx');
      try {
        await fh.writeFile(`${token} ${new Date().toISOString()}\n`, 'utf8');
      } finally {
        await fh.close();
      }
      return token;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }

    // EEXIST: чужой лок — либо жив (ждём с бэкоффом), либо протух (владелец
    // умер между open() и unlink(), например убит по SIGKILL). Но «протух» по
    // mtime — эвристика, не факт смерти: настоящий владелец может оказаться
    // просто медленным, и тогда наш unlink снимает ЕЩЁ АКТИВНЫЙ лок. Отличить
    // «умер» от «завис» здесь не из чего — поэтому владение не проверяется на
    // этом конце: если «протухший» владелец на самом деле жив и однажды дойдёт
    // до releaseLock, тот увидит по токену, что файл уже не его, и не удалит
    // чужой (см. releaseLock ниже) — вот настоящая защита от P0, дефект 1.
    let stale = false;
    try {
      const st = await fsStat(lockPath);
      stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
    } catch {
      // Лок исчез между нашей попыткой open() и стат — чужой владелец сам
      // его снял; пробуем захватить снова через обычный бэкофф ниже (не
      // немедленно — см. комментарий у sleep ниже).
      stale = true;
    }
    if (stale) {
      try {
        await unlink(lockPath);
      } catch {
        /* кто-то другой уже убрал — не страшно */
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`withRegistryLock: timed out waiting for lock ${lockPath} (busy > ${LOCK_TIMEOUT_MS}ms)`);
    }
    // Раньше протухший путь снятия лока сразу повторял open() без ожидания —
    // несколько waiter'ов, увидевших один и тот же протухший лок, кидались
    // перезахватывать место одновременно (толпа), а если исходный владелец на
    // самом деле жив (см. выше), гонка steal→release→steal шла по кругу без
    // паузы. Токен в releaseLock уже не даёт этому портить данные, но толпа —
    // просто трата CPU/FD; протухший путь теперь ничем не отличается от
    // занятого: тот же бэкофф, та же пауза перед повторной попыткой.
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
}

/**
 * Освобождает лок, ТОЛЬКО если он всё ещё наш — сверяет токен в файле с тем,
 * что мы сами туда писали при захвате (acquireLock/makeLockToken).
 *
 * Несовпадение — штатный исход «мы больше не владеем этим локом», а не
 * ошибка: кто-то другой посчитал наш лок протухшим (см. комментарий в
 * acquireLock), снял его и создал свой. Раньше release делал безусловный
 * unlink ПО ПУТИ — это сносило ЧУЖОЙ, ещё активный лок и открывало дорогу
 * третьему участнику зайти, пока второй ещё работает (P0, дефект 1,
 * кросс-ревью раунд 2). Здесь просто молча выходим — новый владелец освободит
 * лок сам, когда закончит.
 *
 * TOCTOU-окно между чтением содержимого и unlink() осознанно не устраняется
 * (это не одна атомарная ОС-операция) — оно и раньше было, просто без всякой
 * проверки владения. Окно — наносекунды, деградация не хуже прежнего.
 */
async function releaseLock(lockPath, token) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    if (!raw.startsWith(`${token} `)) return; // лок уже не наш — не трогаем
    await unlink(lockPath);
  } catch {
    /* best-effort: release не должен падать поверх успешной операции —
       файл мог уже исчезнуть (гонка с чужим unlink) или стать нечитаемым */
  }
}

/**
 * Сериализует ЛЮБУЮ мутацию реестра (putRun/updateRun/removeRun/clearRegistry/
 * reapOrphans) через файловый лок `<registryPath>.lock`. НЕ реентерабелен:
 * fn не должен сам вызывать другую функцию, обёрнутую withRegistryLock —
 * вложенный acquireLock будет ждать лок, который держит он же сам, и упрётся
 * в собственный таймаут. Все мутации в этом модуле поэтому самодостаточны
 * (сами делают свой read+write внутри одного захвата, а не зовут друг друга).
 */
export async function withRegistryLock(registryPath, fn) {
  const p = getRegistryPath(registryPath);
  await ensureDir(p);
  const lockPath = `${p}.lock`;
  const token = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

/**
 * Read registry. Returns {} if missing or corrupt (corrupt -> {} and logs).
 */
export async function readRegistry(registryPath) {
  const p = getRegistryPath(registryPath);
  try {
    const raw = await readFile(p, 'utf8');
    if (raw.trim() === '') return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    // corrupt file -> treat as empty but do not throw; caller may overwrite
    return {};
  }
}

/**
 * Atomic write via tmp+rename.
 */
export async function writeRegistry(data, registryPath) {
  const p = getRegistryPath(registryPath);
  await ensureDir(p);
  const tmp = `${p}.tmp.${randomUUID()}`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, p);
}

export async function getRun(runId, registryPath) {
  const reg = await readRegistry(registryPath);
  return reg[runId] ?? null;
}

export async function listRuns(registryPath) {
  const reg = await readRegistry(registryPath);
  return reg;
}

export async function putRun(runId, entry, registryPath) {
  return withRegistryLock(registryPath, async () => {
    const reg = await readRegistry(registryPath);
    reg[runId] = entry;
    await writeRegistry(reg, registryPath);
    return entry;
  });
}

export async function updateRun(runId, patch, registryPath) {
  return withRegistryLock(registryPath, async () => {
    const reg = await readRegistry(registryPath);
    if (!reg[runId]) return null;
    reg[runId] = { ...reg[runId], ...patch };
    await writeRegistry(reg, registryPath);
    return reg[runId];
  });
}

/**
 * Атомарный "перечитать → решить → записать" одним захватом лока (P0 п.2,
 * раунд 2 кросс-ревью). Нужен там, где решение об изменении записи зависит от
 * СВЕЖЕГО её состояния, а не от снимка, сделанного до захвата лока — например,
 * claim просроченного рана в reapExpiredRuns: снимок реестра мог устареть, и
 * между чтением снимка и этим вызовом владелец успел продлить аренду
 * (renewLease). Без единого захвата лока на "перечитать+решить+записать" то же
 * самое TOCTOU-окно просто сдвинулось бы на пару строк, а не исчезло.
 *
 * `mutate(freshEntry)` вызывается СИНХРОННО с точки зрения лока (внутри одного
 * захвата) и обязана вести себя как чистая функция снимка: либо вернуть patch
 * (объект полей для слияния — запись сохраняется), либо falsy (запись не
 * трогаем вообще, лок просто освобождается). НЕ звать отсюда putRun/updateRun/
 * removeRun и другие обёрнутые withRegistryLock функции — вложенный
 * acquireLock упрётся в собственный таймаут (см. комментарий у withRegistryLock).
 *
 * Возвращает обновлённую запись при записи, иначе null (записи нет или mutate
 * отказал).
 */
export async function updateRunIf(runId, mutate, registryPath) {
  return withRegistryLock(registryPath, async () => {
    const reg = await readRegistry(registryPath);
    const fresh = reg[runId];
    if (!fresh) return null;
    const patch = await mutate(fresh);
    if (!patch) return null;
    reg[runId] = { ...fresh, ...patch };
    await writeRegistry(reg, registryPath);
    return reg[runId];
  });
}

export async function removeRun(runId, registryPath) {
  return withRegistryLock(registryPath, async () => {
    const reg = await readRegistry(registryPath);
    if (!(runId in reg)) return false;
    delete reg[runId];
    await writeRegistry(reg, registryPath);
    return true;
  });
}

export async function clearRegistry(registryPath) {
  return withRegistryLock(registryPath, async () => {
    await writeRegistry({}, registryPath);
  });
}

// Helper: is pid alive?
export function isPidAlive(pid) {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true; // exists but no permission
    return false;
  }
}

export function isPgidAlive(pgid) {
  if (!isSafePgid(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

/**
 * reapOrphans: пройти реестр, убить группы мёртвых записей, вычистить завершённые.
 * - если pid мёртв -> удалить запись (попытка kill pgid если pgid жив)
 * - если state !== 'running' -> удалить (завершённые)
 * - если pid жив но pgid мёртв -> удалить
 * - если state === 'reaping' и pid ЖИВ -> НЕ трогать (claim reapExpiredRuns,
 *   kill уже в процессе); если pid МЁРТВ -> удалить как завершённую (зависший
 *   claim, см. комментарий ниже)
 * Returns { removed: string[], killed: string[] }
 */
export async function reapOrphans(registryPath) {
  return withRegistryLock(registryPath, () => reapOrphansLocked(registryPath));
}

async function reapOrphansLocked(registryPath) {
  const p = getRegistryPath(registryPath);
  const reg = await readRegistry(p);
  const removed = [];
  const killed = [];
  let mutated = false;

  for (const [runId, entry] of Object.entries(reg)) {
    const pid = entry?.pid;
    const pgid = entry?.pgid;
    const state = entry?.state;
    const pidAlive = isPidAlive(pid);
    // identity имеет смысл проверять, только если по данным реестра процесс
    // вообще жив: мёртвому pid сигнал и так не пойдёт, а readProcStarttime
    // мёртвого вернёт null и ложно засчитается как "чужой". Записи без
    // procStarttime (старый формат) identityOk всегда true — поведение как раньше.
    const identityOk = !pidAlive || isSameProcessAsRegistered(entry, pid);

    // 'reaping' — claim reapExpiredRuns'а (P0 п.2, раунд 2 кросс-ревью): kill
    // уже в процессе, им владеет killRun (SIGTERM → grace → возможный SIGKILL
    // → finalize). Пока pid жив — это НЕ финальное состояние для reapOrphans,
    // а промежуточное чужой работы: удаление записи или повторный SIGTERM
    // отсюда мешали бы killRun (например, его повторной identity-проверке
    // перед эскалацией, см. P1 п.3) и рвали бы pollRun для тех, кто ждёт исход
    // (запись исчезла бы у них из-под ног). Мёртвый pid при state:'reaping' —
    // наоборот, ЗАВИСШИЙ claim (тот, кто его поставил, не дожил до финализации,
    // например сам упал) — такую запись чистим ниже как обычную завершённую.
    if (state === 'reaping' && pidAlive) {
      continue;
    }

    // Completed/error records should be cleaned (they should have been removed on finish, but handle stale)
    if (state && state !== 'running') {
      delete reg[runId];
      removed.push(runId);
      mutated = true;
      // try kill group if still alive — но не когда pid жив под чужим identity
      if (identityOk) {
        if (isPgidAlive(pgid)) {
          if (killPgid(pgid, 'SIGTERM')) killed.push(runId);
        } else if (pidAlive) {
          if (killPid(pid, 'SIGTERM')) killed.push(runId);
        }
      }
      continue;
    }

    const pgidAlive = isPgidAlive(pgid);

    if (!pidAlive && !pgidAlive) {
      // dead process, just clean
      delete reg[runId];
      removed.push(runId);
      mutated = true;
      continue;
    }

    if (!pidAlive && pgidAlive) {
      // Лидер (pid) мёртв, группа осиротела — identity тут проверять не по
      // чему (лидера, с которым сверяли бы starttime, уже нет): чистим как раньше.
      if (killPgid(pgid, 'SIGTERM')) killed.push(runId);
      delete reg[runId];
      removed.push(runId);
      mutated = true;
      continue;
    }

    if (pidAlive && !identityOk) {
      // pid жив, но это не наш процесс — переиспользованный номер. Запись
      // чистим (иначе висела бы в реестре вечно), сигнал НЕ посылаем.
      delete reg[runId];
      removed.push(runId);
      mutated = true;
      continue;
    }

    if (pidAlive && !pgidAlive) {
      // inconsistent: pid alive but pgid not -> clean, kill pid
      if (killPid(pid, 'SIGTERM')) killed.push(runId);
      delete reg[runId];
      removed.push(runId);
      mutated = true;
    }

    // both alive, identity наша -> keep (running)
  }

  if (mutated) {
    await writeRegistry(reg, p);
  }
  return { removed, killed };
}
