import { assertModelSpec, ModelSpecError } from './model-spec.js';
// Неблокирующий API bridge-core (контракт v2: docs/contracts/dsh-bridge-async-v2.md).
// Переиспользует registry.js (реестр ранов, безопасный kill) и envelope.js (Envelope v1),
// а также buildEnv/resolveDshBinary из run.js (тот же белый список env, что у runDsh).
//
// Архитектура (там, где контракт молчал — см. отчёт агента):
//  - Реестр остаётся единственным источником PID/PGID, но для завершённого рана
//    источником истины становится envelopeFile (var/runs/<runId>.envelope.json),
//    пишется один раз через link()-based "создать, если отсутствует" (сильнее, чем
//    tmp+rename: гарантирует, что при гонке выигрывает ровно один автор).
//  - pollRun/waitRun/killRun НЕ доверяют полю `state` в реестре для принятия решений —
//    оно только для листинга/отладки. Источник истины: наличие envelopeFile + текущая
//    живость pid (isPidAlive). Это делает поведение корректным независимо от того,
//    кто и когда записал реестровую запись (сам startDsh или тестовая фикстура).
//  - startDsh — если процесс НЕ удалось породить (spawn_failed) — не резолвит RunHandle
//    (в типе RunHandle нет варианта ошибки), а бросает исключение. Ловить/оборачивать —
//    забота вызывающего слоя (extensions/dsh-task), контракт v2 явно этого не описывает.
//  - "Наблюдатель" (child.on('close')) живёт в процессе, вызвавшем startDsh: если этот
//    процесс не переживёт ран, никто не сможет вернуть настоящий exit-код — тогда более
//    поздний pollRun/killRun (даже из другого процесса) лениво синтезирует error/killed
//    по инварианту 3 контракта, не подвешивая вызывающего.

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, appendFile, unlink, link, mkdir, stat as fsStat, open as fsOpen } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  getRegistryPath,
  putRun,
  getRun,
  updateRun,
  updateRunIf,
  listRuns,
  reapOrphans,
  killPgid,
  killPid,
  isPidAlive,
  readProcStarttime,
  isSameProcessAsRegistered,
} from './registry.js';
import { synthesizeError, synthesizeCompleted, tryParseEnvelopeFromStdout } from './envelope.js';
import { buildEnv, resolveDshBinary } from './run.js';
import { withAskProtocol } from './task-protocol.js';

// var/runs/<runId>.{log,envelope.json,steer.jsonl} — рядом с реестром.
function runPaths(runId, registryPath) {
  const regPath = getRegistryPath(registryPath);
  const runsDir = join(dirname(regPath), 'runs');
  return {
    runsDir,
    logFile: join(runsDir, `${runId}.log`),
    envelopeFile: join(runsDir, `${runId}.envelope.json`),
    steerFile: join(runsDir, `${runId}.steer.jsonl`),
  };
}

async function tryReadEnvelopeFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

const LABEL_MAX_LEN = 80;

/**
 * Нормализует метку рана (label) для реестра: обрезает пробелы по краям,
 * пустая после trim — как отсутствие (null), длинная — обрезается до 80
 * символов. Только этот путь (v2/startDsh) кладёт label в реестр: у v1
 * (run.js) запись реестра удаляется вместе с завершением синхронного вызова
 * (см. removeRun в конце runDsh), так что метка для кросс-агентного поиска
 * ЖИВЫХ ранов там не имеет смысла — искать по ней уже некого.
 */
function normalizeLabel(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > LABEL_MAX_LEN ? trimmed.slice(0, LABEL_MAX_LEN) : trimmed;
}

/**
 * Идентификатор сессии DSH, порождённой раном, или null.
 *
 * runId и sessionId — разные вещи из разных слоёв: первый заводит bridge при
 * спавне, второй появляется внутри DSH и виден только в envelope. Владелец, у
 * которого на руках лишь runId, иначе вынужден гадать — и подставляет runId в
 * `--resume`, получая resume_not_found. Живёт здесь, в v2: замороженный v1
 * (run.js) его не импортирует (см. layering.test.js).
 */
export async function sessionIdOfRun(runId, registryPath) {
  const { envelopeFile } = runPaths(runId, registryPath);
  const envelope = await tryReadEnvelopeFile(envelopeFile);
  const sid = envelope?.sessionId;
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

const DEFAULT_TIMEOUT_MS = 1800000;
/**
 * Аренда владельца. Ран живёт, пока им кто-то интересуется: в прямом пути
 * аренду продлевает представитель-скрипт (extensions/dsh-task/relay.ts) —
 * renewLease раз в RELAY_RENEW_MS (60 с) для каждого рана под наблюдением;
 * dsh_wait/dsh_send — дополнительные акты владения поверх этого цикла. Пять
 * минут тишины означают, что владелец мёртв или завис, а его ран продолжает
 * жечь токены впустую — такой ран забирает reapExpiredRuns.
 */
export const DEFAULT_LEASE_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_GRACE_MS = 2000;

/**
 * Сколько ждать envelope от НАБЛЮДАТЕЛЯ, когда процесс рана уже вышел.
 *
 * Выход процесса и появление envelope — не одно событие: между ними
 * close-хендлер читает лог, разбирает его и делает finalizeIfAbsent (запись
 * tmp + link). Всё это время «pid мёртв, envelope-файла нет» — состояние
 * НОРМАЛЬНОЕ, а не признак умершего наблюдателя.
 *
 * Бюджет общий для killRun и pollRun сознательно: оба закрывают одно и то же
 * окно и обязаны одинаково отвечать на вопрос «наблюдатель ещё жив?». Разъедься
 * эти числа — и два пути к одному рану начали бы давать разные вердикты.
 */
const ENVELOPE_GRACE_MS = 1500;

/**
 * Сколько ждать фактического ИСЧЕЗНОВЕНИЯ процесса после отправленного SIGKILL.
 *
 * Числом совпадает с ENVELOPE_GRACE_MS, но смыслом — нет, и потому живёт
 * отдельно: там ждут донесение наблюдателя, здесь — реакцию ядра на сигнал.
 * Слить их в одну константу значило бы, что попытка подкрутить окно envelope
 * молча меняет поведение SIGKILL-эскалации.
 */
const SIGKILL_REAP_MS = 1500;
const TIMEOUT_SENTINEL = Symbol('waitTimeout');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function raceWithTimeout(promise, ms) {
  // НЕ unref: это ограниченное по времени ожидание, которое вызывающий явно
  // await'ит (killRun) — оно должно держать event loop, иначе, если ничего
  // больше не активно, событие close у unref'нутого child может не успеть
  // обработаться и промис навсегда останется pending.
  return Promise.race([
    promise,
    new Promise((res) => {
      setTimeout(() => res(TIMEOUT_SENTINEL), ms);
    }),
  ]);
}

/**
 * Runs, начатые startDsh() из ЭТОГО процесса. Даёт быстрый путь killRun без
 * повторного опроса isPidAlive и без гонки классификации сигнала (см. flags).
 * runId -> { pid, pgid, flags: {timedOut, killRequested, spawnError, closed},
 * donePromise, exitPromise }. exitPromise (раунд 3 кросс-ревью) резолвится
 * раньше donePromise — сразу на close, до записи envelope на диск — и вместе
 * с flags.closed это единственный источник истины «процесс точно вышел,
 * сигналы по его pid больше не гарантированно наши».
 */
const activeRuns = new Map();

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ. НЕ часть публичного API/контракта v2 (не реэкспортируется
 * из index.js) — прямой доступ к activeRuns нужен исключительно тесту раунда 3
 * кросс-ревью, который детерминированно ловит окно «close-хендлер уже
 * выставил flags.closed=true, но activeRuns.delete ещё не случился (он идёт
 * только ПОСЛЕ finalizeIfAbsent)»: снаружи это окно — гонка с реальным I/O
 * длиной в считанные миллисекунды, поймать её через sleep() ненадёжно и
 * привело бы к flaky-тесту. Тест берёт запись через этот хелпер и выставляет
 * flags.closed вручную, не дожидаясь настоящего close — так же детерминированно
 * проверяя guard в killRun, как если бы окно было поймано по-настоящему.
 */
export function __testOnly_getActiveRun(runId) {
  return activeRuns.get(runId);
}

/**
 * Раны этого процесса — единственные, которые выход сессии вправе убить; чужие
 * сессии видны только через реестр и остаются на сторожа. Возвращает runId из
 * activeRuns, у которых !flags.closed && !flags.spawnError — только живые
 * старты этого процесса.
 */
export function ownRunIds() {
  const ids = [];
  for (const [runId, entry] of activeRuns) {
    if (entry?.flags?.closed) continue;
    if (entry?.flags?.spawnError) continue;
    ids.push(runId);
  }
  return ids;
}

/**
 * Пишет envelopeFile ТОЛЬКО если он ещё не существует (атомарно, через
 * write-tmp + link(), а не rename — link() падает EEXIST, если файл уже есть,
 * так что при гонке выигрывает ровно один автор, остальные читают его результат).
 * Синхронно с этим обновляет state/exitCode в реестре (если запись ещё жива).
 */
async function finalizeIfAbsent(runId, envelope, registryPath, exitCode) {
  const { runsDir, envelopeFile } = runPaths(runId, registryPath);
  await mkdir(runsDir, { recursive: true });
  const tmp = `${envelopeFile}.tmp.${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  let wrote = false;
  try {
    await link(tmp, envelopeFile);
    wrote = true;
  } catch (e) {
    if (!(e && e.code === 'EEXIST')) {
      try {
        await unlink(tmp);
      } catch {}
      throw e;
    }
  }
  try {
    await unlink(tmp);
  } catch {}

  if (!wrote) {
    const existing = await tryReadEnvelopeFile(envelopeFile);
    return existing ?? envelope;
  }

  const state = envelope.status === 'error' ? 'error' : 'completed';
  const resolvedExitCode = exitCode ?? envelope.error?.exitCode ?? null;
  try {
    await updateRun(runId, { state, exitCode: resolvedExitCode }, registryPath);
  } catch {
    /* best-effort: entry may already be gone */
  }
  return envelope;
}

/**
 * startDsh — стартует ран и возвращает управление сразу после атомарной записи
 * в реестр, не дожидаясь завершения процесса.
 */
export async function startDsh(opts) {
  if (!opts || typeof opts.taskFile !== 'string' || opts.taskFile.trim() === '') {
    throw new Error('startDsh: taskFile is required');
  }
  if (!opts.cwd || typeof opts.cwd !== 'string') {
    throw new Error('startDsh: cwd is required');
  }
  if ('model' in (opts || {}) && opts.model !== undefined) {
    if (typeof opts.model === 'string')
      throw new ModelSpecError('startDsh: model must be ModelSpec object, not string');
    assertModelSpec(opts.model);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const registryPath = getRegistryPath(opts.registryPath);
  // Метка рана для dsh_list (см. normalizeLabel выше) — исключительно кросс-агентный
  // поиск живого рана по имени, на сам процесс/спавн никак не влияет.
  const label = normalizeLabel(opts.label);

  // Продолжение по номеру предыдущего РАНА: bridge сам достаёт его sessionId,
  // чтобы вызывающему не приходилось выуживать его из envelope. Явно заданный
  // resumeSessionId сильнее — он адресует сессию напрямую.
  let resumeSessionId = opts.resumeSessionId;
  if (!resumeSessionId && opts.resumeFromRunId) {
    resumeSessionId = await sessionIdOfRun(opts.resumeFromRunId, registryPath);
    if (!resumeSessionId) {
      throw new Error(
        `startDsh: run ${opts.resumeFromRunId} has no session to resume ` +
          '(not finished yet, left no envelope, or already swept)',
      );
    }
  }
  const runId = randomUUID();
  const { runsDir, logFile, envelopeFile, steerFile } = runPaths(runId, registryPath);

  await mkdir(runsDir, { recursive: true });

  let taskText;
  try {
    taskText = await readFile(opts.taskFile, 'utf8');
  } catch (e) {
    throw new Error(`startDsh: cannot read taskFile: ${e.message}`);
  }

  const dshBin = resolveDshBinary(opts.env);
  const args = ['--profile', 'headless'];
  const workerPatch = (opts.env && opts.env.DSH_WORKER_PATCH) || process.env.DSH_WORKER_PATCH;
  if (workerPatch) {
    args.push('--patch', String(workerPatch));
  }
  if (resumeSessionId) {
    args.push('--resume', String(resumeSessionId));
  }
  args.push(withAskProtocol(taskText, opts.askProtocol === true));

  const env = buildEnv(opts.env);
  delete env.DSH_MODEL_PROVIDER;
  delete env.DSH_MODEL;
  delete env.DSH_REASONING_EFFORT;
  if (opts.model !== undefined) {
    env.DSH_MODEL_PROVIDER = opts.model.provider;
    env.DSH_MODEL = opts.model.model;
    if (opts.model.reasoningEffort !== undefined) env.DSH_REASONING_EFFORT = opts.model.reasoningEffort;
  }
  // Канал steering в идущий ход: раннер (Cordis-плагин) опрашивает этот файл и
  // передаёт строки в agent.steer(). Не задан → плагин канал не включает.
  env.DSH_STEER_FILE = steerFile;
  // Тот же runId, что вернёт startDsh. Раннер фазы 2 иначе сгенерирует свой, и
  // envelope придёт с идентификатором, который не сопоставить ни с одним раном.
  env.DSH_RUN_ID = runId;
  const cwd = resolve(opts.cwd);

  // Один и тот же fd для stdout/stderr => один offset в ядре => корректный
  // хронологический merge без гонок между двумя независимыми open() на один путь.
  const logFd = openSync(logFile, 'w');
  let child;
  try {
    child = spawn(dshBin, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    try {
      closeSync(logFd);
    } catch {}
  }

  if (child.pid === undefined) {
    const spawnErr = await new Promise((res) => {
      child.once('error', (err) => res(err));
      child.once('close', () => res(new Error(`spawn_failed: ${dshBin} ENOENT`)));
    });
    throw new Error(`startDsh: spawn failed: ${spawnErr?.message ?? String(spawnErr)}`);
  }

  const pid = child.pid;
  const pgid = pid; // detached => новый лидер группы, pgid === pid
  // identity против переиспользования PID (см. registry.js): /proc/<pid>/stat
  // читается сразу после spawn, пока pid точно наш — позже kill по этому pid
  // сверит текущий starttime с этим значением.
  const procStarttime = readProcStarttime(pid);
  const now = new Date().toISOString();
  const startedMs = Date.parse(now);
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  // Дедлайн дублирует внутренний setTimeout НАМЕРЕННО: таймер живёт в этом
  // процессе и умирает вместе с ним, а запись в реестре переживает его и даёт
  // любому другому процессу право добить просроченный ран.
  const deadlineAt =
    timeoutMs !== 0 && Number.isFinite(timeoutMs) ? new Date(startedMs + timeoutMs).toISOString() : null;
  const sessionHint = resumeSessionId ?? null;

  function killGroupNow(sig) {
    return killPgid(pgid, sig) || killPid(pid, sig);
  }

  // killReason: причина, заданная тем, кто заказал убийство (сторож брошенных
  // ранов). Локальный наблюдатель обязан её сохранить — иначе всякая смерть
  // выглядит как ручная отмена.
  // registrationFailed: P1 п.5, раунд 2 кросс-ревью. putRun ниже может упасть
  // ПОСЛЕ того, как close-хендлер уже подписан — если это случится, storage,
  // недоступный для putRun, скорее всего недоступен и для finalizeIfAbsent
  // (тот же диск/права/реестр). Флаг говорит close-хендлеру: durable envelope
  // не писать вовсе (нечем и незачем — запись рана в реестре и так не
  // состоялась), обойтись синтетическим envelope только в памяти.
  // closed — раунд 3 кросс-ревью: единственный безопасный признак «сигналы по
  // pid/pgid больше слать нельзя» (см. комментарий у таймера эскалации ниже и
  // у close-хендлера). true выставляется строго внутри close-хендлера, первым
  // делом, до какого-либо I/O.
  const flags = {
    timedOut: false,
    killRequested: false,
    spawnError: null,
    killReason: null,
    registrationFailed: false,
    closed: false,
  };

  // Гейт: наблюдатель close-хендлера ждёт, пока начальная запись в реестр не
  // приземлится, чтобы updateRun (внутри finalizeIfAbsent) никогда не гонялся
  // с putRun за один и тот же файл реестра — критично для очень быстрых фикстур
  // (envelope печатается и процесс выходит быстрее, чем успевает завершиться putRun).
  let signalRegistered;
  const registeredPromise = new Promise((res) => {
    signalRegistered = res;
  });

  // Раунд 3 кросс-ревью (блокер Codex): «свой child» САМ ПО СЕБЕ не делает
  // отложенный (setTimeout) SIGKILL безопасным — это объясняет только, ПОЧЕМУ
  // pid не может быть переиспользован ДО того, как close-хендлер увидел выход
  // (реап случается не позже close). ПОСЛЕ close та же гарантия не действует:
  // ОС вправе выдать этот номер другому процессу, и отложенный сигнал по
  // номеру улетел бы уже не туда. Поэтому единственный guard эскалации — флаг
  // flags.closed (выставляется в close-хендлере ниже, вместе с exitPromise),
  // а НЕ identity/liveness-проверка: isPidAlive не отличает «наш зомби, ещё не
  // reaped» от «чужой свежий процесс с тем же номером» — kill(pid,0) отвечает
  // «жив» на оба случая одинаково.
  let timeoutHandle = null;
  let escalateHandle = null;
  if (timeoutMs !== 0 && Number.isFinite(timeoutMs)) {
    timeoutHandle = setTimeout(() => {
      flags.timedOut = true;
      killGroupNow('SIGTERM');
      escalateHandle = setTimeout(() => {
        if (flags.closed) return; // после close сигнал по pid уже не гарантированно наш — см. комментарий выше
        killGroupNow('SIGKILL');
      }, 500);
      if (typeof escalateHandle.unref === 'function') escalateHandle.unref();
    }, timeoutMs);
    if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  }

  child.once('error', (err) => {
    flags.spawnError = err;
  });

  // exitPromise — раунд 3 кросс-ревью: резолвится СРАЗУ на close, ДО
  // какого-либо I/O (в отличие от donePromise, который ждёт ещё и запись
  // envelope на диск через finalizeIfAbsent). Локальному killRun ниже нужно
  // мерить grace против РЕАЛЬНОГО ВЫХОДА процесса, а не против готовности
  // envelope — при медленном сторадже разница легко съедает весь grace, и
  // SIGKILL улетал бы уже ПОСЛЕ выхода (см. флаг closed выше).
  let resolveExit;
  const exitPromise = new Promise((res) => {
    resolveExit = res;
  });

  const donePromise = new Promise((resolveDone) => {
    child.once('close', async (code, signal) => {
      // closed/escalateHandle/exitPromise — первым делом, синхронно, ДО
      // какого-либо I/O или await (в т.ч. до await registeredPromise ниже): с
      // этого момента отложенная SIGKILL-эскалация выше обязана молчать
      // (flags.closed), а локальный killRun — считать процесс вышедшим
      // (exitPromise). Раунд 3 кросс-ревью, блокер Codex про отложенные
      // локальные SIGKILL-пути.
      flags.closed = true;
      if (escalateHandle) clearTimeout(escalateHandle);
      resolveExit({ code, signal });

      // Дальше тело — под try/catch (P1 п.5, раунд 2 кросс-ревью): это
      // async-листенер EventEmitter'а, его никто не await'ит и не оборачивает
      // сам — любое исключение отсюда (включая НЕизвестные заранее падения
      // finalizeIfAbsent: ENOSPC, права, гонка, а не только registrationFailed
      // ниже) улетает как unhandledRejection процесса, а donePromise
      // навсегда остаётся pending. Единственный выход из этой функции —
      // resolveDone(...), никогда reject/throw наружу.
      try {
        await registeredPromise;
        if (timeoutHandle) clearTimeout(timeoutHandle);

        if (flags.registrationFailed) {
          // putRun выше не смог записать ран в реестр — storage, недоступный
          // для этого, почти наверняка недоступен и для finalizeIfAbsent
          // (тот же диск/права). Даже не пытаемся писать durable envelope:
          // писать её всё равно уже некуда, а сам процесс к этому моменту уже
          // убит (см. catch у putRun). Синтетический envelope — только в
          // памяти, resolveDone им и заканчиваем.
          resolveDone(
            synthesizeError(
              runId,
              'spawn_failed',
              'run registration in the registry failed; process was killed, no durable envelope written',
              code ?? null,
              sessionHint,
            ),
          );
          return;
        }

        let envelope;
        if (flags.timedOut) {
          envelope = synthesizeError(runId, 'timeout', `run timed out after ${timeoutMs}ms`, code ?? null, sessionHint);
        } else if (flags.spawnError) {
          envelope = synthesizeError(
            runId,
            'spawn_failed',
            flags.spawnError.message ?? String(flags.spawnError),
            code ?? null,
            sessionHint,
          );
        } else if (flags.killRequested || signal) {
          const code_ = flags.killReason?.code ?? 'killed';
          const msg_ = flags.killReason?.message ?? `run killed (signal=${signal ?? 'n/a'}, code=${code ?? 'n/a'})`;
          envelope = synthesizeError(runId, code_, msg_, code ?? null, sessionHint);
        } else {
          let logContent = '';
          try {
            logContent = await readFile(logFile, 'utf8');
          } catch {}
          const parsed = tryParseEnvelopeFromStdout(logContent);
          if (parsed.envelope && parsed.envelope.runId !== runId) {
            // Задача могла напечатать (случайно эхом или намеренно) чужой
            // runId — принять его как есть значило бы отдать результат/вопрос
            // не тому владельцу. Совпадение runId — часть контракта envelope,
            // не опция.
            const msg = `envelope runId mismatch: got ${parsed.envelope.runId}, expected ${runId}`;
            envelope = synthesizeError(runId, 'malformed_output', msg, code ?? null, sessionHint);
          } else if (parsed.envelope) {
            envelope = parsed.envelope;
          } else if (parsed.malformed) {
            const msg = `malformed envelope: ${parsed.reason ?? 'invalid'}; raw=${parsed.raw.slice(0, 500)}`;
            envelope = synthesizeError(runId, 'malformed_output', msg, code ?? null, sessionHint);
          } else if (code !== 0) {
            const lower = logContent.toLowerCase();
            let errCode = 'nonzero_exit';
            if (lower.includes('resume_not_found') || lower.includes('session not found')) errCode = 'resume_not_found';
            else if (lower.includes('resume_corrupt')) errCode = 'resume_corrupt';
            else if (lower.includes('resume_busy') || lower.includes('already in use')) errCode = 'resume_busy';
            const message = logContent.trim() ? logContent.trim().slice(0, 2000) : `dsh exited with code ${code}`;
            envelope = synthesizeError(runId, errCode, message, code, sessionHint);
          } else {
            envelope = synthesizeCompleted(runId, logContent, sessionHint);
          }
        }

        const finalEnvelope = await finalizeIfAbsent(runId, envelope, registryPath, code ?? null);
        activeRuns.delete(runId);
        resolveDone(finalEnvelope);
      } catch (e) {
        activeRuns.delete(runId);
        resolveDone(
          synthesizeError(
            runId,
            'killed',
            `internal error while finalizing run: ${e?.message ?? String(e)}`,
            code ?? null,
            sessionHint,
          ),
        );
      }
    });
  });

  activeRuns.set(runId, { pid, pgid, flags, donePromise, exitPromise });

  child.unref();

  try {
    await putRun(
      runId,
      {
        pid,
        pgid,
        dshSessionId: sessionHint,
        state: 'running',
        startedAt: now,
        cwd,
        logFile,
        envelopeFile,
        steerFile,
        exitCode: null,
        deadlineAt,
        leaseUntil: new Date(startedMs + leaseMs).toISOString(),
        label,
        procStarttime,
        ...(opts.model !== undefined ? { model: { ...opts.model } } : {}),
      },
      registryPath,
    );
  } catch (e) {
    // Регистрация не удалась (ENOSPC/права/т.п.), но detached-процесс уже
    // запущен: без записи в реестре им никто не сможет управлять (kill/wait/
    // steer) — глушим его сразу, а не оставляем висеть вне реестра. Наблюдателя
    // (close-хендлер) будим через signalRegistered(), иначе он навсегда
    // застрянет на await registeredPromise; таймаут гасим — процесс всё равно
    // уже убит, второй SIGTERM/SIGKILL по нему бессмыслен.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    killGroupNow('SIGKILL');
    activeRuns.delete(runId);
    // ДО signalRegistered(): close-хендлер читает флаг СРАЗУ после того, как
    // registeredPromise проснётся (см. `await registeredPromise` внутри), и
    // обязан увидеть его уже выставленным — порядок здесь имеет значение.
    flags.registrationFailed = true;
    signalRegistered();
    throw new Error(`startDsh: failed to register run in registry, killed the process: ${e.message}`);
  }
  signalRegistered();

  return { runId, pid, pgid, logFile, startedAt: now };
}

/** Неблокирующий снимок состояния. Никогда не ждёт. */
/**
 * Продлить аренду: «владелец жив и ждёт этот ран». Зовётся из действий
 * владения (ожидание, steering), но НЕ из наблюдения (pollRun/list) — иначе
 * посторонний dsh_list воскрешал бы аренду брошенного рана.
 */
export async function renewLease(runId, opts = {}) {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const until = new Date(Date.now() + leaseMs).toISOString();
  let updated;
  try {
    // Продлеваем ТОЛЬКО запись, у которой на момент записи (не снимка ДО
    // вызова, а свежего чтения ВНУТРИ лока — см. updateRunIf) state==='running'
    // (P0 п.2, раунд 2 кросс-ревью). Запись в 'reaping' — уже забранный
    // reapExpiredRuns кандидат: renewLease здесь обязан канонично отказать, а
    // не молча воскресить аренду ПОСЛЕ claim — иначе тот самый TOCTOU (аренда
    // продлена, а ран всё равно убит) просто переехал бы на другую сторону гонки.
    updated = await updateRunIf(
      runId,
      (fresh) => (fresh.state === 'running' ? { leaseUntil: until } : null),
      opts.registryPath,
    );
  } catch {
    // Аренда — подстраховка, а не критический путь: отказ ИЗ-ЗА ОШИБКИ (не
    // канонический отказ выше) не должен ломать ожидание или доставку steering.
    return null;
  }
  return updated ? until : null;
}

/**
 * Причина, по которой ран пора забрать, или null. Отсутствие срока — не
 * повод убивать: записи старого формата и раны без таймаута живут дальше.
 *
 * `entry.state !== 'running'` уже сам по себе исключает 'reaping' (P0 п.2,
 * раунд 2 кросс-ревью): запись, которую reapExpiredRuns уже забрал claim'ом
 * (см. ниже), — не повод вернуть причину повторно. Отдельной ветки для
 * 'reaping' не нужно — общая проверка на 'running' и так её накрывает.
 */
export function expiryReasonOf(entry, now = Date.now()) {
  if (entry?.state !== 'running') return null;
  const deadline = entry.deadlineAt ? Date.parse(entry.deadlineAt) : NaN;
  if (Number.isFinite(deadline) && deadline <= now) return 'deadline_exceeded';
  const lease = entry.leaseUntil ? Date.parse(entry.leaseUntil) : NaN;
  if (Number.isFinite(lease) && lease <= now) return 'owner_gone';
  return null;
}

/**
 * Состояние рана по его envelope. `need_input` не сводится к `completed`:
 * ран закончился, но результата нет — есть вопрос, и владелец обязан на него
 * ответить, а не принять текст за готовую работу.
 */
export function stateOfEnvelope(envelope) {
  if (envelope?.status === 'error') return 'error';
  if (envelope?.status === 'need_input') return 'need_input';
  return 'completed';
}

/**
 * Ждёт появления envelope на диске в пределах бюджета. Путь для ранов ЧУЖОГО
 * процесса: donePromise там недоступен по определению, и единственный канал,
 * которым наблюдатель сообщает результат, — файл.
 *
 * @returns {Promise<object|null>} envelope или null, если за бюджет не появился
 */
async function waitForEnvelopeFile(envelopeFile, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const envelope = await tryReadEnvelopeFile(envelopeFile);
    if (envelope) return envelope;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remaining));
  }
}

/**
 * Ждёт, пока реестровая запись догонит envelope, в пределах бюджета.
 *
 * Envelope-файл и запись в реестре обновляются РАЗДЕЛЬНО и именно в таком
 * порядке: finalizeIfAbsent сначала закрепляет файл через link(), и только
 * потом делает updateRun(state, exitCode). Порядок обязателен — реестр должен
 * отражать тот envelope, который выиграл гонку link() (при EEXIST победитель
 * чужой), — поэтому окно «файл уже виден, запись ещё running/exitCode: null»
 * существует у каждого нормально завершившегося рана.
 *
 * Внутри этого окна запись — не итог, а финализация в полёте, и читать из неё
 * exitCode нельзя: получится `completed` + `exitCode: null` (ровно так падал
 * кейс 4 async-run.test.js в CI на 2 vCPU).
 *
 * Сигнал «догнал» — `state !== 'running'`, а НЕ `exitCode != null`: у рана,
 * убитого сигналом, exitCode легитимно остаётся null, и ждать его пришлось бы
 * весь бюджет впустую.
 *
 * Бюджет — тот же ENVELOPE_GRACE_MS, что и у инварианта 3: это одно и то же
 * окно «наблюдатель ещё дописывает результат», просто с другой стороны.
 *
 * @returns {Promise<object|null>} запись реестра (возможно, всё ещё running,
 *   если бюджет истёк) либо null, если записи нет вовсе
 */
async function awaitRegistrySettled(runId, registryPath, budgetMs) {
  let entry = await getRun(runId, registryPath);
  // Записи нет (легитимный сирота) или она уже терминальная — ждать нечего.
  if (entry?.state !== 'running') return entry;

  const local = activeRuns.get(runId);
  if (local) {
    // in-process: наблюдатель — в этом процессе, у него есть donePromise,
    // который резолвится ПОСЛЕ finalizeIfAbsent целиком, включая updateRun.
    await raceWithTimeout(local.donePromise, budgetMs);
    return await getRun(runId, registryPath);
  }

  // cross-process: donePromise недоступен, единственный канал — реестр;
  // перечитываем его тем же тиком, что и остальные ожидания моста.
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return entry;
    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remaining));
    entry = await getRun(runId, registryPath);
    if (entry?.state !== 'running') return entry;
  }
}

/**
 * Единственное место, где envelope превращается в результат pollRun. Оба пути
 * (envelope уже лежал на диске / дождались его через donePromise либо
 * waitForEnvelopeFile) обязаны отвечать одинаково, иначе гонка вылечена лишь
 * на одном из них.
 *
 * По истечении бюджета отдаём прежний ответ — envelope с тем exitCode, что
 * есть. Это случай «наблюдатель умер между link и updateRun»: он честно
 * деградирует до `exitCode: null`, а не подвешивает вызывающего.
 */
async function resultFromEnvelope(runId, envelope, registryPath) {
  const entry = await awaitRegistrySettled(runId, registryPath, ENVELOPE_GRACE_MS);
  return {
    runId,
    state: stateOfEnvelope(envelope),
    envelope,
    exitCode: entry?.exitCode ?? envelope.error?.exitCode ?? null,
  };
}

export async function pollRun(runId, opts = {}) {
  const registryPath = opts.registryPath;
  const { envelopeFile } = runPaths(runId, registryPath);

  const existing = await tryReadEnvelopeFile(envelopeFile);
  if (existing) {
    return await resultFromEnvelope(runId, existing, registryPath);
  }

  const entry = await getRun(runId, registryPath);
  if (!entry) {
    throw new Error(`pollRun: unknown runId "${runId}" (no registry entry, no envelope)`);
  }

  if (isPidAlive(entry.pid)) {
    return { runId, state: 'running', envelope: null, exitCode: null };
  }

  // Инвариант 3, ПЕРВАЯ половина: pid мёртв, envelope-файла нет — но само по
  // себе это ещё НЕ значит «наблюдатель не дожил». Выход процесса и появление
  // envelope — разные события: между ними close-хендлер читает лог, разбирает
  // его и делает finalizeIfAbsent. Всё это окно оба условия истинны у
  // совершенно здорового рана.
  //
  // Синтезировать killed внутри окна нельзя, и цена ошибки здесь не «неточный
  // ответ»: finalizeIfAbsent закрепляет envelope через link() — «создать, если
  // нет», — поэтому настоящий envelope, дописанный мгновением позже, получает
  // EEXIST и отбрасывается. Успешно завершённый ран НАВСЕГДА остаётся убитым,
  // и dsh_wait так и отвечает директору.
  //
  // Поэтому сначала даём наблюдателю добежать — тем же бюджетом, которым
  // killRun ждёт donePromise (ENVELOPE_GRACE_MS), и двумя путями по числу
  // видов наблюдателя.
  const local = activeRuns.get(runId);
  const settled = local
    ? // in-process: ран наш, наблюдатель — в этом процессе, у него есть
      // donePromise (резолвится ПОСЛЕ записи envelope). Ждём его напрямую —
      // ровно как killRun в своём окне «closed, но ещё не удалён».
      await raceWithTimeout(local.donePromise, ENVELOPE_GRACE_MS)
    : // cross-process: ран чужой (обычный случай для pollRun через реестр),
      // donePromise недоступен — единственный канал наблюдателя до нас это
      // файл на диске, значит перечитываем его в пределах того же бюджета.
      await waitForEnvelopeFile(envelopeFile, ENVELOPE_GRACE_MS);

  if (settled && settled !== TIMEOUT_SENTINEL) {
    return await resultFromEnvelope(runId, settled, registryPath);
  }

  // Инвариант 3, ВТОРАЯ половина: бюджет истёк, envelope так и не появился —
  // вот теперь наблюдатель действительно не дожил. Прежнее поведение:
  // синтезируем error/killed, не подвисая. (finalizeIfAbsent ниже всё равно
  // отдаст настоящий envelope, если тот успел появиться в последний момент:
  // при EEXIST он возвращает уже лежащий на диске.)
  const envelope = synthesizeError(
    runId,
    'killed',
    'run process is no longer alive and produced no envelope (observer likely died before writing it)',
    null,
    entry.dshSessionId ?? null,
  );
  const finalEnvelope = await finalizeIfAbsent(runId, envelope, registryPath, null);
  return {
    runId,
    state: stateOfEnvelope(finalEnvelope),
    envelope: finalEnvelope,
    exitCode: null,
  };
}

function abortableSleep(ms, signal) {
  // НЕ unref (см. raceWithTimeout выше) — это внутренний тик активного цикла
  // waitRun, который вызывающий явно await'ит с ограниченным waitMs.
  return new Promise((resolveSleep) => {
    const t = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      cleanup();
      resolveSleep();
    }
    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ждёт завершения не дольше waitMs. Таймаут ожидания — не ошибка рана.
 * AbortSignal отменяет ОЖИДАНИЕ, а не ран.
 */
export async function waitRun(runId, opts) {
  if (!opts || typeof opts.waitMs !== 'number' || !Number.isFinite(opts.waitMs) || opts.waitMs < 0) {
    throw new Error('waitRun: opts.waitMs is required and must be a non-negative number');
  }
  const { waitMs, registryPath, signal } = opts;

  // Ожидание — заявка владельца на ран: продлеваем аренду до опроса, чтобы
  // длинное окно не истекло само по себе.
  await renewLease(runId, { registryPath, leaseMs: opts.leaseMs });

  let result = await pollRun(runId, { registryPath });
  if (result.state !== 'running' || waitMs === 0) return result;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return result;
    const remaining = deadline - Date.now();
    const interval = Math.min(DEFAULT_POLL_INTERVAL_MS, remaining);
    if (interval <= 0) break;
    await abortableSleep(interval, signal);
    if (signal?.aborted) return result;
    result = await pollRun(runId, { registryPath });
    if (result.state !== 'running') return result;
  }
  return result;
}

/** SIGTERM всей группе, затем SIGKILL после grace. Идемпотентен. */
export async function killRun(runId, opts = {}) {
  const registryPath = opts.registryPath;
  const requestedSignal = opts.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  // По умолчанию это явная отмена. Сторож просроченных ранов зовёт то же самое,
  // но обязан оставить в envelope СВОЮ причину — иначе владелец увидит "killed"
  // и решит, что ран отменили руками.
  const reasonCode = opts.reasonCode ?? 'killed';
  const reasonMessage = opts.reasonMessage ?? null;
  const { envelopeFile } = runPaths(runId, registryPath);

  // Уже завершён — идемпотентный no-op.
  const existingEnv = await tryReadEnvelopeFile(envelopeFile);
  if (existingEnv) {
    return { runId, killed: false, state: existingEnv.status === 'error' ? 'error' : 'completed' };
  }

  // Быстрый путь: ран стартован startDsh() в ЭТОМ процессе — есть живой
  // наблюдатель (child.on('close')), просто ждём его донесение.
  //
  // Identity (P1 п.3, раунд 2 кросс-ревью) здесь НЕ перепроверяется — и это
  // не упущение, а исключение by construction, НО (раунд 3 кросс-ревью,
  // блокер Codex, п.4 — скоуп расширен координатором на этот же путь)
  // обоснование этого исключения — НЕ «свой child» само по себе и НЕ «запись
  // жива в activeRuns»: activeRuns.delete происходит ПОСЛЕ finalizeIfAbsent
  // (I/O), то есть позже, чем реальный close, и потому не может служить
  // границей безопасности. Настоящая граница — событие close конкретно этого
  // child: пока оно не случилось, реап физически не мог произойти, и ОС не
  // могла отдать pid/pgid другому процессу. ЭТО ЖЕ ПРАВИЛО «no signals after
  // close» действует и здесь, не только у отложенной SIGKILL-эскалации (см.
  // flags.closed/exitPromise ниже) — просто здесь «отложенность» другой
  // природы: не setTimeout, а I/O-задержка finalizeIfAbsent между началом
  // close-хендлера (flags.closed=true — его самая первая строка) и
  // activeRuns.delete. Guard ниже закрывает именно это окно.
  const local = activeRuns.get(runId);
  if (local) {
    if (local.flags.closed) {
      // closed уже true, а запись всё ещё в activeRuns — то самое окно между
      // началом close-хендлера и activeRuns.delete (см. комментарий выше).
      // Процесс уже вышел, реап мог уже случиться — killPgid/killPid здесь
      // рискуют попасть в чужой, позже стартовавший процесс с тем же
      // номером. Убивать уже нечего: честно ждём envelope из donePromise
      // (тот же bounded ENVELOPE_GRACE_MS и тот же fallback-паттерн, что и ниже) и
      // отдаём его, не посылая ни одного сигнала.
      const envelope = await raceWithTimeout(local.donePromise, ENVELOPE_GRACE_MS);
      const finalEnvelope =
        envelope === TIMEOUT_SENTINEL
          ? await finalizeIfAbsent(
              runId,
              synthesizeError(
                runId,
                reasonCode,
                reasonMessage ?? 'run already exited before killRun observed it (local observer already closed)',
                null,
                null,
              ),
              registryPath,
              null,
            )
          : envelope;
      return { runId, killed: false, state: finalEnvelope.status === 'error' ? 'error' : 'completed' };
    }

    local.flags.killRequested = true;
    if (opts.reasonCode) {
      local.flags.killReason = { code: reasonCode, message: reasonMessage };
    }
    const killedSomething = killPgid(local.pgid, requestedSignal) || killPid(local.pid, requestedSignal);

    // grace меряет ВЫХОД процесса (exitPromise — резолвится в самом начале
    // close-хендлера, до записи envelope), а НЕ готовность envelope
    // (donePromise) — раунд 3 кросс-ревью: finalizeIfAbsent пишет файл на
    // диск, и при медленном сторадже это I/O легко съедает весь grace, так
    // что SIGKILL улетал бы уже ПОСЛЕ реального выхода процесса (и
    // потенциального реапа) — ровно тот отложенный сигнал по номеру, которого
    // физика closed требует избегать.
    const exited = await raceWithTimeout(local.exitPromise, graceMs);
    if (exited === TIMEOUT_SENTINEL && requestedSignal === 'SIGTERM' && !local.flags.closed) {
      // !flags.closed — обязательный guard прямо перед отправкой: close мог
      // случиться в тот же момент, что и истечение grace (гонка Promise.race
      // с двумя независимыми таймерами), а флаг проверяется синхронно и
      // авторитетно, в отличие от исхода гонки.
      killPgid(local.pgid, 'SIGKILL') || killPid(local.pid, 'SIGKILL');
      await raceWithTimeout(local.exitPromise, SIGKILL_REAP_MS);
    }

    // Процесс уже вышел (или мы это только что подтвердили/форсировали) —
    // осталось дождаться envelope из donePromise (пишет close-хендлер),
    // ограниченно по времени: как раньше, с синтетическим fallback, если
    // финализация неожиданно зависла.
    let envelope = await raceWithTimeout(local.donePromise, ENVELOPE_GRACE_MS);
    if (envelope === TIMEOUT_SENTINEL) {
      const fallback = synthesizeError(
        runId,
        reasonCode,
        reasonMessage ?? 'run killed via killRun (escalated, observer slow to finalize)',
        null,
        null,
      );
      envelope = await finalizeIfAbsent(runId, fallback, registryPath, null);
    }
    return { runId, killed: killedSomething, state: envelope.status === 'error' ? 'error' : 'completed' };
  }

  // Кросс-процессный путь: нет локального наблюдателя (другой процесс стартовал
  // ран, либо этот процесс уже забыл про него). Работаем только через реестр,
  // используя killPgid/killPid — никогда напрямую process.kill.
  const entry = await getRun(runId, registryPath);
  if (!entry) {
    return { runId, killed: false, state: 'error' };
  }

  const pidAlive = isPidAlive(entry.pid);
  if (!pidAlive) {
    const envelope = synthesizeError(
      runId,
      reasonCode,
      reasonMessage ?? 'run already exited before killRun observed it',
      null,
      entry.dshSessionId ?? null,
    );
    await finalizeIfAbsent(runId, envelope, registryPath, null);
    return { runId, killed: false, state: 'error' };
  }

  // identity против переиспользования PID (см. registry.js): pid жив, но это
  // может быть СОВСЕМ ДРУГОЙ процесс, если ОС выдала этот номер заново уже
  // после того, как наш реально умер. Сверяем ДО первого сигнала — не после.
  if (!isSameProcessAsRegistered(entry, entry.pid)) {
    const envelope = synthesizeError(
      runId,
      reasonCode,
      reasonMessage ??
        `pid ${entry.pid} identity mismatch: process was reused by the OS, treating run as already gone (no signal sent)`,
      null,
      entry.dshSessionId ?? null,
    );
    await finalizeIfAbsent(runId, envelope, registryPath, null);
    return { runId, killed: false, state: 'error' };
  }

  const killedSomething = killPgid(entry.pgid, requestedSignal) || killPid(entry.pid, requestedSignal);

  if (requestedSignal === 'SIGTERM') {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isPidAlive(entry.pid)) {
      await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    if (isPidAlive(entry.pid)) {
      // Перед КАЖДОЙ эскалацией — повторная identity-проверка (P1 п.3, раунд 2
      // кросс-ревью), не только перед первым сигналом. Между отправкой SIGTERM
      // и этой строкой прошёл целый grace-период — за это время реальный
      // процесс вполне мог умереть НЕ от нашего SIGTERM (он его мог и
      // проигнорировать, как и не проигнорировать, а всё равно упасть по
      // другой причине), а ОС — успеть отдать тот же номер СОВЕРШЕННО ДРУГОМУ
      // процессу. `entry` в замыкании — снимок ДО первого сигнала, он не видит
      // изменений за время ожидания, поэтому перечитываем запись из реестра
      // заново (а не полагаемся на устаревший `entry`) и сверяем СВЕЖИЙ
      // /proc/<pid>/stat с тем, что там записано.
      const freshEntry = (await getRun(runId, registryPath)) ?? entry;
      if (isSameProcessAsRegistered(freshEntry, entry.pid)) {
        killPgid(entry.pgid, 'SIGKILL') || killPid(entry.pid, 'SIGKILL');
        await sleep(150);
      }
      // Иначе: расхождение — процесс, отвечающий этому pid ПРЯМО СЕЙЧАС, уже
      // не наш. SIGKILL туда НЕ шлём (это был бы сигнал случайному чужому
      // живому процессу), но запись всё равно финализируем ниже — иначе она
      // висела бы running вечно, хотя isPidAlive(entry.pid) технически true.
    }
  } else {
    await sleep(150);
  }

  const envelope = synthesizeError(
    runId,
    reasonCode,
    reasonMessage ?? `run killed via killRun (${requestedSignal})`,
    null,
    entry.dshSessionId ?? null,
  );
  await finalizeIfAbsent(runId, envelope, registryPath, null);
  return { runId, killed: killedSomething, state: 'error' };
}

/** Инкрементальное чтение вывода (merged stdout+stderr) для стриминга в UI. */
export async function readRunOutput(runId, opts = {}) {
  const { logFile } = runPaths(runId, opts.registryPath);
  const offset = opts.offset ?? 0;
  const maxBytes = opts.maxBytes ?? 65536;

  let stat;
  try {
    stat = await fsStat(logFile);
  } catch {
    return { chunk: '', nextOffset: offset, eof: true };
  }

  const size = stat.size;
  if (offset >= size) {
    return { chunk: '', nextOffset: offset, eof: true };
  }

  const toRead = Math.min(maxBytes, size - offset);
  const fh = await fsOpen(logFile, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const nextOffset = offset + toRead;
    return { chunk: buf.toString('utf8'), nextOffset, eof: nextOffset >= size };
  } finally {
    await fh.close();
  }
}

export { runPaths };

// Окно честной проверки доставки: раннер (steer-channel.js) поллит канал раз в
// 150 мс, поэтому ждать нужно дольше одного его такта, но не бесконечно —
// 1200 мс с шагом 50 мс: несколько тактов раннера укладываются с запасом, а
// вызывающий не подвисает надолго, если канал никто не читает.
const STEER_DELIVERY_WAIT_MS = 1200;
const STEER_DELIVERY_POLL_MS = 50;

/**
 * sendToRun — дописать сообщение в steer-канал идущего рана.
 *
 * Доставку подтверждает не факт appendFile, а то, что раннер СТРОКУ РЕАЛЬНО
 * вычитал: он ведёт `<steerFile>.offset`, и status:"delivered" даётся только
 * после того, как этот offset догонит конец нашей записи. Без этого читатель
 * (steer-channel плагина, поллинг 150 мс) мог уже сделать финальный дренаж
 * канала ДО того, как appendFile долетел до диска — тогда ложный
 * status:"delivered" означал бы, что сообщение никто никогда не прочитает, а
 * вызывающий (dsh_send) считал бы его уже доставленным и не повторял.
 *
 * Трёхзначный `status` (P1 п.4, раунд 2 кросс-ревью) — раньше здесь был
 * бинарный delivered:boolean, и delivered:false по таймауту означало ДВЕ
 * разных ситуации сразу: ран мог быть мёртв (сообщение потеряно НАВСЕГДА,
 * надо слать заново другим путём) или жив на момент повторной проверки, но
 * подтверждения чтения нет (это НЕ гарантия доставки; дублировать всё равно
 * нельзя — двойной steering остаётся реальным риском, а сообщение с высокой
 * вероятностью будет прочитано). Разные ситуации требуют разных действий от
 * вызывающего, а один и тот же delivered:false не давал их различить:
 *
 * - "delivered"    — offset раннера догнал конец записи, чтение подтверждено;
 * - "pending"      — запись в канал завершилась, ран был жив при повторной
 *                    проверке, но offset не дошёл за окно ожидания:
 *                    подтверждения чтения нет — это не гарантия доставки; не
 *                    повод повторять или дублировать через другой путь;
 * - "undeliverable" — ран в терминальном состоянии, offset не дошёл (включая
 *                    случай "ран уже был не running ДО отправки" — запись в
 *                    канал даже не делалась, это старый ранний return).
 *
 * Поле `delivered:boolean` сохранено для обратной совместимости и всегда
 * равно `status === "delivered"`.
 *
 * Контракт: docs/contracts/dsh-steer-channel-v1.md,
 * docs/contracts/dsh-bridge-async-v2.md (раздел `sendToRun`/`dsh_send`).
 */
export async function sendToRun(runId, text, opts = {}) {
  if (typeof runId !== 'string' || runId === '') {
    throw new Error('sendToRun: runId is required');
  }
  if (typeof text !== 'string' || text === '') {
    throw new Error('sendToRun: text must be a non-empty string');
  }

  const registryPath = getRegistryPath(opts.registryPath);
  const { steerFile, envelopeFile } = runPaths(runId, registryPath);
  const entry = await getRun(runId, registryPath);
  if (entry === null) {
    // Реестр выметает терминальные записи примерно за 30 секунд, а envelope
    // остаётся на диске навсегда — так что у нормально ЗАВЕРШИВШЕГОСЯ рана
    // записи может уже не быть. По контракту
    // (docs/contracts/dsh-bridge-async-v2.md, раздел sendToRun/dsh_send)
    // «undeliverable» — это ран в терминальном состоянии, доставить невозможно;
    // выметенный завершённый ран ровно таков, поэтому возвращаем штатный
    // недоставленный результат вместо броска («unknown runId» он уже не по праву).
    if (await tryReadEnvelopeFile(envelopeFile)) {
      return {
        delivered: false,
        status: 'undeliverable',
        steerFile,
        pendingBytes: await pendingBytesOf(steerFile),
        waitedMs: 0,
      };
    }

    throw new Error(`sendToRun: unknown runId ${runId}`);
  }

  const target = entry.steerFile ?? steerFile;

  // Состояние выводим тем же способом, что pollRun: поле state в реестре может
  // протухнуть, а слать в мёртвый ран бессмысленно.
  const before = await pollRun(runId, { registryPath });
  if (before.state !== 'running') {
    // Ран уже был не running ДО того, как мы вообще что-то записали — канал
    // читать некому, доставка гарантированно не случится. Запись даже не
    // делалась (старый ранний return) — здесь нечего "ещё дождаться".
    return {
      delivered: false,
      status: 'undeliverable',
      steerFile: target,
      pendingBytes: await pendingBytesOf(target),
      waitedMs: 0,
    };
  }

  const line = `${JSON.stringify({ v: 1, text, sentAt: new Date().toISOString() })}\n`;
  await appendFile(target, line, 'utf8');
  // Steering — тоже действие владения: пока родитель правит ран, он не брошен.
  await renewLease(runId, { registryPath, leaseMs: opts.leaseMs });

  let endOffset = null;
  try {
    endOffset = (await fsStat(target)).size;
  } catch {
    endOffset = null;
  }

  const waitStarted = Date.now();
  const deadline = waitStarted + STEER_DELIVERY_WAIT_MS;
  let caughtUp = false;
  if (endOffset !== null) {
    for (;;) {
      const processed = await readSteerOffset(target);
      if (processed !== null && processed >= endOffset) {
        caughtUp = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(STEER_DELIVERY_POLL_MS, remaining));
    }
  }
  const waitedMs = Date.now() - waitStarted;

  if (caughtUp) {
    return {
      delivered: true,
      status: 'delivered',
      steerFile: target,
      pendingBytes: await pendingBytesOf(target),
      waitedMs,
    };
  }

  // Не дождались подтверждения за окно. Перечитываем состояние рана, чтобы
  // отличить "легло в канал, ран был жив при повторной проверке, чтение не
  // подтверждено" (pending) от "уже никогда не прочитают" (undeliverable) —
  // ран мог и завершиться ПОКА мы ждали, и это здесь узнаётся ТОЛЬКО
  // повторным опросом, а не тем снимком `before`, что был до записи в канал.
  const after = await pollRun(runId, { registryPath });
  const finalStatus = after.state === 'running' ? 'pending' : 'undeliverable';

  return {
    delivered: false,
    status: finalStatus,
    steerFile: target,
    pendingBytes: await pendingBytesOf(target),
    waitedMs,
  };
}

/** Текущий `<steerFile>.offset` раннера в байтах, или null — файла ещё нет/битый. */
async function readSteerOffset(steerFile) {
  try {
    const raw = await readFile(`${steerFile}.offset`, 'utf8');
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Сколько байт канала раннер ещё не обработал (по его же .offset). */
async function pendingBytesOf(steerFile) {
  let size = 0;
  try {
    size = (await fsStat(steerFile)).size;
  } catch {
    return 0;
  }
  let processed = 0;
  try {
    processed = Number((await readFile(`${steerFile}.offset`, 'utf8')).trim());
    if (!Number.isFinite(processed) || processed < 0) processed = 0;
  } catch {
    processed = 0;
  }
  return Math.max(0, size - processed);
}

/**
 * Сторож брошенных ранов.
 *
 * Закрывает разрыв, из-за которого DSH переживал своего владельца: процесс
 * стартует detached (собственная process group), поэтому смерть OMP-сессии или
 * сабагента-представителя до него физически не доходит, а внутренний таймаут
 * живёт в памяти стартовавшего процесса и умирает вместе с ним.
 *
 * Здесь единственный источник истины — реестр: любой процесс bridge может
 * добить ран, чей дедлайн прошёл или чью аренду никто не продлевает.
 *
 * Проверки владения здесь НЕТ и добавлять её нельзя — это зафиксированное
 * решение, а не дыра (дважды порывались «чинить»): аренду продлевает живой
 * владелец (relay.ts RELAY_RENEW_MS = 60 с), поэтому истёкшая аренда означает,
 * что владельца больше нет в живых и защищать некого; сторож, жнущий только
 * свои раны, не жал бы ничего — свои и так добиваются на session_shutdown,
 * а брошенные чужие остались бы навсегда. Подробно:
 * docs/contracts/dsh-bridge-async-v2.md, раздел
 * "Decision: the reaper does NOT check ownership".
 * @returns {Promise<{killed: string[], reasons: Record<string, string>}>}
 */
export async function reapExpiredRuns(registryPath, opts = {}) {
  const p = getRegistryPath(registryPath);
  const now = opts.now ?? Date.now();
  const reg = await listRuns(p);
  const killed = [];
  const reasons = {};

  for (const [runId, entry] of Object.entries(reg)) {
    const reason = expiryReasonOf(entry, now);
    if (reason === null) continue;

    // Атомарный claim (P0 п.2, раунд 2 кросс-ревью): снимок реестра выше
    // (listRuns) мог устареть уже к этой строке — между чтением снимка и этим
    // местом владелец мог продлить аренду (renewLease). Старый код звал
    // killRun прямо по снимку, вне транзакции: renewLease между снимком и
    // kill продлевал аренду, а ран всё равно убивался. Здесь под ОДНИМ
    // захватом лока перечитываем запись и решаем ЗАНОВО — если TOCTOU-окно
    // просто отодвинуть на пару строк без общего лока, дефект никуда не
    // денется. claimedReason фиксируется ИЗНУТРИ mutate (замыкание): это
    // причина по СВЕЖЕЙ записи, а не по устаревшему `reason` снимка снаружи.
    let claimedReason = null;
    let claimed;
    try {
      claimed = await updateRunIf(
        runId,
        (fresh) => {
          const freshReason = expiryReasonOf(fresh, now);
          if (freshReason === null) return null; // продлили либо уже не running — не наша добыча
          claimedReason = freshReason;
          return { state: 'reaping', reapClaimAt: new Date().toISOString() };
        },
        p,
      );
    } catch {
      claimed = null;
    }
    if (!claimed || !claimedReason) continue;

    const message =
      claimedReason === 'deadline_exceeded'
        ? `run exceeded its deadline (${claimed.deadlineAt}) and was reaped`
        : `run was abandoned: owner lease expired at ${claimed.leaseUntil} and nobody renewed it`;

    // Kill — только ПОСЛЕ успешного claim: до этой точки мы уже единственные,
    // кто вправе забрать именно этот ран (state:'reaping' в реестре это фиксирует).
    const res = await killRun(runId, {
      registryPath: p,
      graceMs: opts.graceMs,
      reasonCode: claimedReason,
      reasonMessage: message,
    });
    // killed=false означает, что ран успел завершиться сам между claim'ом и
    // сигналом — это не наша добыча, в отчёт не идёт.
    if (res.killed) {
      killed.push(runId);
      reasons[runId] = claimedReason;
    }
  }

  return { killed, reasons };
}

/**
 * Полное обслуживание реестра одним вызовом: добить просроченные раны, затем
 * вычистить завершённые записи. Порядок важен — reapOrphans не трогает живые
 * процессы, поэтому просроченные надо снять до него.
 */
export async function sweepRuns(registryPath, opts = {}) {
  const expired = await reapExpiredRuns(registryPath, opts);
  const orphans = await reapOrphans(getRegistryPath(registryPath));
  return { expired: expired.killed, reasons: expired.reasons, removed: orphans.removed, killed: orphans.killed };
}
