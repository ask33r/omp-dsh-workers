import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getRegistryPath, putRun, removeRun, reapOrphans, killPgid, killPid, readProcStarttime } from './registry.js';
import { withAskProtocol } from './task-protocol.js';
import { synthesizeCompleted, synthesizeError, tryParseEnvelopeFromStdout } from './envelope.js';
import { assertModelSpec, ModelSpecError } from './model-spec.js';

/**
 * Minimal allowlist env — передаётся поверх минимального белого списка.
 * Контракт: env поверх whitelist. Реализуем: берём whitelist, затем накладываем opts.env.
 */
const ENV_WHITELIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'NODE_ENV',
  // forwarded for tests (FAKE_*), real dsh ignores them
  'FAKE_DSH_LOG',
  'FAKE_DSH_CHILD_LOG',
  'FAKE_ENVELOPE_RUNID',
  'FAKE_ENVELOPE_SESSION',
  'DSH_BINARY',
  'DSH_BRIDGE_RUNS_FILE',
];

export function buildEnv(extra) {
  const base = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  // Forward test-only FAKE_ vars (also respects explicit opts.env)
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('FAKE_') && !(k in base)) base[k] = v;
  }
  if (!base.PATH) base.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  if (extra) {
    for (const [k, v] of Object.entries(extra)) base[k] = String(v);
  }
  return base;
}

export function resolveDshBinary(optsEnv) {
  // Prefer explicit env override from opts.env (test-isolated) over global process.env
  if (optsEnv?.DSH_BINARY) return optsEnv.DSH_BINARY;
  if (process.env.DSH_BINARY) return process.env.DSH_BINARY;
  return 'dsh';
}

/**
 * runDsh — core
 * @param {object} opts
 * @param {string} opts.taskFile - path to brief file (NEVER from argv string)
 * @param {string} [opts.resumeSessionId]
 * @param {string} opts.cwd
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeoutMs] default 1800000
 * @param {(chunk:string)=>void} [opts.onStdout]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.registryPath] override for tests
 * @returns {Promise<import('./envelope.js').Envelope>}
 */
export async function runDsh(opts) {
  if (!opts || typeof opts.taskFile !== 'string' || opts.taskFile.trim() === '') {
    throw new Error('runDsh: taskFile is required');
  }
  if (!opts.cwd || typeof opts.cwd !== 'string') {
    throw new Error('runDsh: cwd is required');
  }
  if ('model' in (opts || {}) && opts.model !== undefined) {
    if (typeof opts.model === 'string') throw new ModelSpecError('runDsh: model must be ModelSpec object, not string');
    assertModelSpec(opts.model);
  }

  const timeoutMs = opts.timeoutMs ?? 1800000;
  const registryPath = getRegistryPath(opts.registryPath);
  const runId = randomUUID();

  // 1. reap orphans at start (best-effort, don't fail run)
  try {
    await reapOrphans(registryPath);
  } catch {}

  // 2. read taskFile (phase 1 fidelity — brief читается из файла)
  let taskText;
  try {
    taskText = await readFile(opts.taskFile, 'utf8');
  } catch (e) {
    const env = synthesizeError(runId, 'spawn_failed', `cannot read taskFile: ${e.message}`, null);
    return env;
  }

  // 3. Build argv: ["--profile","headless", ...] + task positional(s)
  // Контракт: headless принимает позиционный [task...] — передаём taskText как один позиционный аргумент.
  // Чтобы избежать shell-инъекции: shell:false, argv-массив.
  const dshBin = resolveDshBinary(opts.env);
  const args = ['--profile', 'headless'];
  if (opts.resumeSessionId) {
    args.push('--resume', String(opts.resumeSessionId));
  }
  // Task как позиционный — один элемент массива, даже если содержит пробелы/unicode/кавычки
  args.push(withAskProtocol(taskText, opts.askProtocol === true));

  const env = buildEnv(opts.env);
  // Владение env модели: ровно три ключа вырезаются всегда, ставятся только из валидированного opts.model.
  delete env.DSH_MODEL_PROVIDER;
  delete env.DSH_MODEL;
  delete env.DSH_REASONING_EFFORT;
  if (opts.model !== undefined) {
    env.DSH_MODEL_PROVIDER = opts.model.provider;
    env.DSH_MODEL = opts.model.model;
    if (opts.model.reasoningEffort !== undefined) env.DSH_REASONING_EFFORT = opts.model.reasoningEffort;
  }
  // Сквозной идентификатор рана: раннер фазы 2 подставит его в envelope вместо
  // собственного случайного. Steer-канала на синхронном пути нет.
  env.DSH_RUN_ID = runId;
  const cwd = resolve(opts.cwd);

  // 4. spawn detached
  let child;
  let stdoutBuf = '';
  let stderrBuf = '';
  let timedOut = false;
  const killedBySignal = false;
  let abortKilled = false;
  // closed — раунд 3 кросс-ревью (блокер Codex): единственный безопасный
  // признак «сигналы по pid/pgid больше слать нельзя». Пока close не
  // случился, наш detached child не reaped, и ОС не может отдать его номер
  // другому процессу — сигнал по этому номеру гарантированно наш. После close
  // reap уже произошёл, номер мог достаться кому угодно — отложенный сигнал
  // (см. таймер эскалации ниже) обязан молчать. Выставляется в close-хендлере.
  let closed = false;

  try {
    child = spawn(dshBin, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const envelope = synthesizeError(runId, 'spawn_failed', e.message ?? String(e), null);
    // print envelope to stdout per contract (last line JSON)
    // runDsh as library returns envelope; CLI will print
    return envelope;
  }

  // spawn error (e.g., ENOENT): child.pid === undefined => process never started
  if (child.pid === undefined) {
    const spawnErr = await new Promise((resolve) => {
      child.on('error', (err) => resolve(err));
      child.on('close', () => resolve(new Error(`spawn_failed: ${dshBin} ENOENT`)));
    });
    return synthesizeError(runId, 'spawn_failed', spawnErr.message ?? String(spawnErr), null);
  }

  const pid = child.pid;
  const pgid = pid; // detached => child is leader of new pgid == pid
  // identity против переиспользования PID (P1 п.3, раунд 2 кросс-ревью, см.
  // registry.js): читаем сразу после spawn, пока pid точно наш — v1 раньше
  // писал pid/pgid без этого, и его kill-пути (killGroup здесь, cmdKill в
  // CLI) оставались без identity-проверки в принципе, в отличие от v2.
  const procStarttime = readProcStarttime(pid);

  // Register run
  const now = new Date().toISOString();
  // deadlineAt пишем и здесь: синхронный путь тоже спавнит detached-процесс,
  // и если владелец умрёт во время ожидания, запись останется running, а DSH
  // продолжит работать. Аренду (leaseUntil) НЕ ставим намеренно: этот путь
  // блокирующий и продлевать её некому — сторож судил бы по ней о живом ране
  // и убивал бы работающую задачу.
  try {
    await putRun(
      runId,
      {
        pid,
        pgid,
        dshSessionId: opts.resumeSessionId ?? null,
        state: 'running',
        startedAt: now,
        cwd,
        deadlineAt:
          timeoutMs !== 0 && Number.isFinite(timeoutMs) ? new Date(Date.parse(now) + timeoutMs).toISOString() : null,
        leaseUntil: null,
        procStarttime,
        ...(opts.model !== undefined ? { model: { ...opts.model } } : {}),
      },
      registryPath,
    );
  } catch (e) {
    // Регистрация не удалась (ENOSPC/права/т.п.), а detached-процесс уже
    // запущен — без записи в реестре им никто не сможет управлять; глушим
    // сразу, а не оставляем висеть вне реестра (см. spawn-registry-failure.test.js).
    killPgid(pgid, 'SIGKILL') || killPid(pid, 'SIGKILL');
    return synthesizeError(
      runId,
      'spawn_failed',
      `failed to register run in registry, killed the process: ${e.message}`,
      null,
    );
  }
  // Helper to kill process group
  function killGroup(sig = 'SIGTERM') {
    // killPgid отказывает на pgid <= 1 и на собственной группе: kill(-1) снёс бы всю сессию
    if (killPgid(pgid, sig)) return true;
    return killPid(pid, sig);
  }

  // Wire AbortSignal
  let onAbort;
  if (opts.signal) {
    if (opts.signal.aborted) {
      killGroup('SIGTERM');
      abortKilled = true;
    } else {
      onAbort = () => {
        abortKilled = true;
        killGroup('SIGTERM');
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // Timeout — unref so a long default (30min) does not keep event loop alive.
  // Эскалация SIGKILL (раунд 3 кросс-ревью): без неё таймаут ничего не
  // гарантировал — задача, игнорирующая SIGTERM, никогда не дала бы close, и
  // ожидание exitInfo ниже висело бы вечно (см. тест
  // «timeout escalates to SIGKILL when the process ignores SIGTERM»).
  // ~500мс — тот же интервал, что у v2 (async-run.js); v1 не имеет права
  // импортировать v2 (layering.test.js), поэтому таймер продублирован, а не
  // переиспользован. Guard `if (!closed)` — единственно верная проверка (см.
  // комментарий у флага closed выше): pid этого child не может достаться
  // другому процессу, пока close не случился, а после — может, и слать сигнал
  // туда уже нельзя.
  let timeoutHandle = null;
  let escalateHandle = null;
  if (timeoutMs !== 0 && Number.isFinite(timeoutMs)) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      escalateHandle = setTimeout(() => {
        if (!closed) killGroup('SIGKILL');
      }, 500);
      if (typeof escalateHandle.unref === 'function') escalateHandle.unref();
    }, timeoutMs);
    if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  }

  // Stream stdout
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const s = String(chunk);
      stdoutBuf += s;
      if (opts.onStdout) {
        try {
          opts.onStdout(s);
        } catch {}
      }
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += String(chunk);
    });
  }

  const exitInfo = await new Promise((resolveExit) => {
    child.on('close', (code, signal) => {
      // closed и отмена таймера эскалации — первым делом, до любого другого
      // кода: с этого момента отложенный SIGKILL выше обязан молчать (см.
      // комментарий у флага closed).
      closed = true;
      if (escalateHandle) clearTimeout(escalateHandle);
      resolveExit({ code, signal });
    });
    child.on('error', (err) => resolveExit({ code: null, signal: null, spawnError: err }));
  });

  clearTimeout(timeoutHandle);
  if (onAbort && opts.signal) {
    try {
      opts.signal.removeEventListener('abort', onAbort);
    } catch {}
  }

  // If spawn failed (ENOENT) — should have been caught above, but handle late error event
  if (exitInfo.spawnError) {
    const err = exitInfo.spawnError;
    // If process never started, clean registry
    try {
      await removeRun(runId, registryPath);
    } catch {}
    const envelope = synthesizeError(runId, 'spawn_failed', err.message ?? String(err), null);
    return envelope;
  }

  // After exit, remove from registry (keeping for reap test: we clean immediately)
  try {
    await removeRun(runId, registryPath);
  } catch {}

  // Timeout -> error envelope. Процесс уже мёртв: close (см. промис выше) уже
  // случился, а если требовался SIGKILL — он ушёл эскалационным таймером ДО
  // close, не здесь. Слать сигнал повторно на этом месте значило бы слать его
  // ПОСЛЕ close — потенциально не туда (см. комментарий у флага closed выше;
  // раунд 3 кросс-ревью, блокер Codex про отложенные локальные SIGKILL-пути).
  if (timedOut) {
    return synthesizeError(runId, 'timeout', `run timed out after ${timeoutMs}ms`, exitInfo.code ?? null);
  }

  if (abortKilled || killedBySignal || exitInfo.signal) {
    const sig = exitInfo.signal || 'SIGTERM';
    // Distinguish timeout already handled; this is cancellation/kill
    if (abortKilled) {
      return synthesizeError(runId, 'killed', `run killed by AbortSignal (${sig})`, exitInfo.code ?? null);
    }
    if (exitInfo.signal) {
      return synthesizeError(runId, 'killed', `run killed by signal ${sig}`, exitInfo.code ?? null);
    }
  }

  // Phase 2: if dsh printed envelope v1 as last line, validate and forward
  // If valid -> return it (bridge validates). If missing/malformed -> synthesize malformed_output.
  const parsed = tryParseEnvelopeFromStdout(stdoutBuf);

  if (parsed.envelope) {
    // runId — часть контракта envelope, не опция: задача могла напечатать
    // (эхом или намеренно) чужой runId, и приняв его как есть, bridge отдал
    // бы результат/вопрос не тому владельцу.
    if (parsed.envelope.runId !== runId) {
      const msg = `envelope runId mismatch: got ${parsed.envelope.runId}, expected ${runId}`;
      return synthesizeError(runId, 'malformed_output', msg, exitInfo.code ?? null);
    }
    // Validate already done. Bridge must ensure envelope v is 1 and status correct; forward it.
    // Do not synthesize; return dsh's envelope.
    // For phase 2 contract: dsh prints envelope itself.
    return parsed.envelope;
  }

  if (parsed.malformed) {
    // Envelope line present but invalid JSON shape -> malformed_output
    const msg = `malformed envelope: ${parsed.reason ?? 'invalid'}; raw=${parsed.raw.slice(0, 500)}`;
    if (stderrBuf) {
      return synthesizeError(
        runId,
        'malformed_output',
        `${msg}; stderr: ${stderrBuf.slice(0, 1000)}`,
        exitInfo.code ?? null,
      );
    }
    return synthesizeError(runId, 'malformed_output', msg, exitInfo.code ?? null);
  }

  // No envelope from dsh (phase 1 behavior): synthesize from exit code + stdout
  // До фазы 2 envelope собирает bridge из exit-кода и stdout (sessionId: null, need_input не встречается)
  if (exitInfo.code !== 0) {
    const exitCode = exitInfo.code;
    // Map resume errors if stderr hints (future-proof)
    // For now, generic nonzero_exit
    let code = 'nonzero_exit';
    const stderrLower = stderrBuf.toLowerCase();
    if (stderrLower.includes('resume_not_found') || stderrLower.includes('session not found'))
      code = 'resume_not_found';
    else if (stderrLower.includes('resume_corrupt')) code = 'resume_corrupt';
    else if (stderrLower.includes('resume_busy') || stderrLower.includes('already in use')) code = 'resume_busy';

    const message = stderrBuf.trim() ? stderrBuf.trim().slice(0, 2000) : `dsh exited with code ${exitCode}`;
    return synthesizeError(runId, code, message, exitCode);
  }

  // exit 0, no envelope -> completed with stdout as result
  return synthesizeCompleted(runId, stdoutBuf, null);
}

export { getRegistryPath };
