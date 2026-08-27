import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { runDsh } from '../src/run.js';
import {
  readRegistry,
  writeRegistry,
  reapOrphans,
  isSafePgid,
  isSafePid,
  killPgid,
  isPidAlive,
} from '../src/registry.js';
import { validateEnvelope, tryParseEnvelopeFromStdout } from '../src/envelope.js';
import { killTestProcess } from './kill-safe.js';
import { rmTestDir } from './tmp-cleanup.js';

const FIXTURES_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

// Изолированный вызов без мутации глобального process.env.
// Всё, что нужно fake-dsh, передаётся через opts.env; реестр — через registryPath.
async function runWithRegistry(taskText, opts = {}) {
  const registryPath = await tempRegistryPath();
  const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
  const taskFile = join(dir, 'task.txt');
  await writeFile(taskFile, taskText, 'utf8');
  try {
    const env = {
      DSH_BINARY: FIXTURES_DSH,
      ...(opts.extraEnv || {}),
      ...(opts.env || {}),
    };
    // FAKE_* лог-файлы тоже через opts.env (не через process.env, чтобы не гонять глобалку)
    const envelope = await runDsh({
      taskFile,
      cwd: dir,
      registryPath,
      timeoutMs: opts.timeoutMs ?? 5000, // маленький дефолт для тестов, чтобы не висеть 30 минут
      signal: opts.signal,
      onStdout: opts.onStdout,
      resumeSessionId: opts.resumeSessionId,
      env,
    });
    return { envelope, registryPath, taskFile, dir };
  } finally {
    await rmTestDir(dir);
  }
}

/**
 * Реестр — в СВОЁМ каталоге, а не файлом прямо в /tmp.
 *
 * runPaths() кладёт логи/envelope в `dirname(registryPath)/runs`. Пока реестр
 * лежал файлом в корне tmpdir, этим каталогом был ОБЩИЙ `/tmp/runs` — один на
 * все кейсы файла, на весь набор и вообще на всю машину (включая параллельные
 * прогоны из других worktree). Свой каталог на кейс убирает и пересечение
 * кейсов между собой, и чужие прогоны из уравнения.
 */
async function tempRegistryPath() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-test-reg-'));
  return join(dir, 'runs.json');
}

async function cleanupRegistry(registryPath) {
  // Сносим каталог реестра целиком: в нём же лежит runs/ с логами и envelope.
  await rmTestDir(dirname(registryPath));
}

describe('bridge-core', () => {
  it('fresh run — completed envelope (phase 1 synthesis)', async () => {
    const { envelope, registryPath } = await runWithRegistry('hello world');
    try {
      assert.equal(envelope.v, 1);
      assert.equal(envelope.status, 'completed');
      assert.equal(envelope.result, 'hello world');
      assert.equal(envelope.sessionId, null);
      assert.ok(envelope.runId);
      const v = validateEnvelope(envelope);
      assert.equal(v.valid, true, v.reason);
      const reg = await readRegistry(registryPath);
      assert.deepEqual(reg, {}, 'registry cleaned after success');
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('resume run — forwards onStdout chunks and passes --resume argv', async () => {
    const logFile = join(tmpdir(), `fake-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    await writeFile(logFile, '', 'utf8');
    const chunks = [];
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, 'hello resume', 'utf8');
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 5000,
        resumeSessionId: 'session-xyz-123',
        onStdout: (c) => chunks.push(c),
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_LOG: logFile },
      });
      assert.equal(envelope.status, 'completed');
      assert.ok(chunks.length >= 1, 'onStdout called');
      assert.ok(chunks.join('').includes('hello resume'));
      const logRaw = await readFile(logFile, 'utf8');
      const last = logRaw.trim().split('\n').pop();
      assert.ok(last, 'fake log should have entry');
      const info = JSON.parse(last);
      assert.ok(info.argv.includes('--resume'), 'resume flag in argv');
      assert.ok(info.argv.includes('session-xyz-123'));
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
      await rm(logFile, { force: true });
    }
  });

  it('resume: forwards valid envelope from dsh (phase 2)', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_ENVELOPE_OK__ my result', {
      resumeSessionId: 'sess-999',
    });
    try {
      assert.equal(envelope.v, 1);
      assert.equal(envelope.status, 'completed');
      assert.equal(envelope.result, 'my result');
      assert.equal(envelope.sessionId, 'sess-999');
      assert.equal(validateEnvelope(envelope).valid, true);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  // Дефект 5 кросс-ревью: envelope с ЧУЖИМ runId (эхо/подделка задачей) не
  // должен приниматься как есть на синхронном пути (v1) точно так же, как на v2.
  it('envelope с чужим runId (v1) → malformed_output', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_ENVELOPE_OK__ чужой ответ', {
      env: { FAKE_ENVELOPE_RUNID: 'some-other-run-id' },
    });
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'malformed_output');
      assert.match(envelope.error.message, /runId mismatch/);
      assert.match(envelope.error.message, /got some-other-run-id/);
      assert.match(envelope.error.message, new RegExp(`expected ${envelope.runId}`));
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('need_input envelope forwarded (phase 2)', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_ENVELOPE_NEED_INPUT__ please?');
    try {
      assert.equal(envelope.status, 'need_input');
      assert.equal(envelope.question, 'What is your name?');
      assert.equal(validateEnvelope(envelope).valid, true);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('resume_not_found → error envelope', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_RESUME_NOT_FOUND__');
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'resume_not_found');
      assert.ok(envelope.error.message.length > 0);
      assert.equal(envelope.error.exitCode, 1);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('resume_corrupt → error', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_RESUME_CORRUPT__');
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'resume_corrupt');
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('resume_busy → error', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_RESUME_BUSY__');
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'resume_busy');
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('exit !=0 → nonzero_exit with stderr', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_EXIT1__');
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'nonzero_exit');
      assert.ok(envelope.error.message.includes('simulated failure'));
      assert.equal(envelope.error.exitCode, 1);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('malformed envelope → malformed_output', async () => {
    const { envelope, registryPath } = await runWithRegistry('__FAKE_MALFORMED__');
    try {
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'malformed_output');
      assert.ok(envelope.error.message.includes('malformed envelope'));
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('envelope missing — synthesized completed (phase 1)', async () => {
    const { envelope, registryPath } = await runWithRegistry('plain output task');
    try {
      assert.equal(envelope.status, 'completed');
      assert.equal(envelope.result, 'plain output task');
      assert.equal(envelope.error, undefined);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('Unicode / multiline / large brief without distortion', async () => {
    const big = `Привет 🌟 — test — ${'x'.repeat(8000)}\nline2\nline3 unicode: café naïve\nspecial: $\`"\n' \\ ; | & \` $(echo pwned)\``;
    const { envelope, registryPath } = await runWithRegistry(big);
    try {
      assert.equal(envelope.status, 'completed');
      assert.equal(envelope.result, big);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('shell injection via task content is not executed (shell:false + file)', async () => {
    const probe = join(tmpdir(), `pwned-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const payload = `hello; touch ${probe} ; echo pwned`;
    const { envelope, registryPath } = await runWithRegistry(payload);
    try {
      assert.equal(envelope.status, 'completed');
      assert.equal(envelope.result, payload);
      assert.equal(existsSync(probe), false, 'shell injection must not create file');
    } finally {
      await cleanupRegistry(registryPath);
      await rm(probe, { force: true });
    }
  });

  it('onStdout streaming receives exact bytes', async () => {
    const collected = [];
    const { envelope, registryPath } = await runWithRegistry('stream me', { onStdout: (c) => collected.push(c) });
    try {
      assert.equal(envelope.status, 'completed');
      assert.equal(collected.join(''), 'stream me\n');
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('timeout → error timeout and kills pgid (including child)', async () => {
    const registryPath = await tempRegistryPath();
    const childLog = join(tmpdir(), `child-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_SPAWN_CHILD__ hang', 'utf8');
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 400,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_CHILD_LOG: childLog },
      });
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'timeout');
      await new Promise((r) => setTimeout(r, 300));
      let childPid = null;
      try {
        childPid = parseInt(await readFile(childLog, 'utf8'), 10);
      } catch {}
      if (childPid) {
        // isPidAlive вместо process.kill(pid, 0): та же семантика (ESRCH →
        // мёртв, EPERM → жив), но проба идёт через общие гарды registry.js —
        // в тестах моста не остаётся ни одного прямого process.kill.
        assert.equal(isPidAlive(childPid), false, `child pid ${childPid} must be dead after pgid kill`);
      }
      const reg = await readRegistry(registryPath);
      assert.deepEqual(reg, {}, 'registry cleaned after timeout');
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
      await rm(childLog, { force: true });
    }
  });

  // Раунд 3 кросс-ревью (блокер Codex): таймаут без эскалации никогда не
  // убивал процесс, который игнорирует SIGTERM — runDsh висел вечно, ожидая
  // close, которого не будет. Фикс — собственный таймер эскалации (SIGKILL
  // через ~500мс, если close ещё не случился к этому моменту).
  it('timeout escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_IGNORE_TERM__ escalation test', 'utf8');
    const pidFile = join(tmpdir(), `ignore-term-pid-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      const t0 = Date.now();
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 1500,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_PIDFILE: pidFile },
      });
      const elapsed = Date.now() - t0;

      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'timeout');
      assert.ok(elapsed < 5000, `SIGTERM-ignoring run must still resolve via SIGKILL escalation, took ${elapsed}ms`);

      let pid = null;
      try {
        pid = parseInt(await readFile(pidFile, 'utf8'), 10);
      } catch {}
      assert.ok(pid, 'fixture must have recorded its own pid via FAKE_PIDFILE');
      assert.equal(isPidAlive(pid), false, `process ${pid} ignoring SIGTERM must be dead after SIGKILL escalation`);
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
      await rm(pidFile, { force: true });
    }
  });

  it('AbortSignal → killed', async () => {
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_HANG__ abort test', 'utf8');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 350);
    timer.unref();
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        signal: ac.signal,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'killed');
    } finally {
      clearTimeout(timer);
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
    }
  });

  it('spawn_failed when binary missing', async () => {
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, 'hello', 'utf8');
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 3000,
        env: { DSH_BINARY: '/nonexistent/dsh-binary-xyz' },
      });
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.code, 'spawn_failed');
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
    }
  });

  it('registry atomic write and reapOrphans cleans dead pid', async () => {
    const registryPath = await tempRegistryPath();
    try {
      await writeRegistry(
        {
          'dead-run': {
            pid: 999999,
            pgid: 999999,
            dshSessionId: null,
            state: 'running',
            startedAt: new Date().toISOString(),
          },
          'stale-completed': {
            pid: 999998,
            pgid: 999998,
            dshSessionId: null,
            state: 'completed',
            startedAt: new Date().toISOString(),
          },
        },
        registryPath,
      );
      const res = await reapOrphans(registryPath);
      assert.ok(res.removed.includes('dead-run'));
      assert.ok(res.removed.includes('stale-completed'));
      assert.deepEqual(res.killed, [], 'мёртвые записи не должны никого убивать');
      const reg = await readRegistry(registryPath);
      assert.deepEqual(reg, {});
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  // Регрессия: pgid=1 в реестре означал kill(-1) — SIGTERM всем процессам пользователя,
  // то есть суицид всей сессии вместе с прогоном тестов.
  it('kill guards: pgid <= 1 / own pgid / own pid never receive a signal', async () => {
    for (const bad of [1, 0, -1, -999, 1.5, null, undefined, '1234', NaN]) {
      assert.equal(isSafePgid(bad), false, `pgid ${String(bad)} must be rejected`);
      assert.equal(killPgid(bad, 'SIGTERM'), false, `killPgid(${String(bad)}) must be a no-op`);
    }
    for (const bad of [1, 0, -1, process.pid, null, '42']) {
      assert.equal(isSafePid(bad), false, `pid ${String(bad)} must be rejected`);
    }
    assert.equal(isSafePgid(999998), true, 'обычный pgid остаётся разрешённым');
    assert.equal(isSafePid(999998), true, 'обычный pid остаётся разрешённым');

    // Реестр с pgid:1 должен быть вычищен молча, без единого сигнала наружу.
    const registryPath = await tempRegistryPath();
    try {
      await writeRegistry(
        {
          'broadcast-trap': {
            pid: 1,
            pgid: 1,
            dshSessionId: null,
            state: 'completed',
            startedAt: new Date().toISOString(),
          },
        },
        registryPath,
      );
      const res = await reapOrphans(registryPath);
      assert.deepEqual(res.killed, [], 'kill(-1) broadcast must never happen');
      assert.deepEqual(res.removed, ['broadcast-trap']);
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('reapOrphans keeps live run (without leaking event loop)', async () => {
    const registryPath = await tempRegistryPath();
    // Используем sleep 2 вместо 30, чтобы не висеть минуту после убийства группы
    const child = spawn('sleep', ['2'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    const pgid = pid;
    child.unref();
    // child.disconnect не нужен — stdio ignore
    await writeRegistry(
      {
        'live-run': { pid, pgid, dshSessionId: null, state: 'running', startedAt: new Date().toISOString() },
      },
      registryPath,
    );
    try {
      const res = await reapOrphans(registryPath);
      assert.equal(res.removed.length, 0, 'live run not removed');
      const reg = await readRegistry(registryPath);
      assert.ok(reg['live-run'], 'live entry kept');
    } finally {
      // Через killTestProcess: гарды isSafePgid/isSafePid не дают cleanup'у
      // выродиться в kill(-1) broadcast, если pid/pgid окажутся фиктивными.
      killTestProcess(pid, pgid, 'SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
      try {
        await reapOrphans(registryPath);
      } catch {}
      const t = setTimeout(() => {}, 100);
      t.unref();
      await cleanupRegistry(registryPath);
    }
  });

  it('registry write is atomic (tmp+rename): no partial JSON', async () => {
    const registryPath = await tempRegistryPath();
    try {
      const writes = [];
      for (let i = 0; i < 10; i++) {
        writes.push(
          writeRegistry(
            { [`run-${i}`]: { pid: 1000 + i, pgid: 1000 + i, state: 'running', startedAt: new Date().toISOString() } },
            registryPath,
          ),
        );
      }
      await Promise.all(writes);
      const raw = await readFile(registryPath, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), 'registry must be valid JSON after concurrent writes');
    } finally {
      await cleanupRegistry(registryPath);
    }
  });

  it('env whitelist: DSH_BRIDGE_RUNS_FILE isolated, custom env passed through', async () => {
    const logFile = join(tmpdir(), `env-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    await writeFile(logFile, '', 'utf8');
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, 'hello env', 'utf8');
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_LOG: logFile, MY_CUSTOM_VAR: 'hello-custom' },
      });
      assert.equal(envelope.status, 'completed');
      const raw = await readFile(logFile, 'utf8');
      const info = JSON.parse(raw.trim().split('\n').pop());
      assert.equal(info.env.MY_CUSTOM_VAR, 'hello-custom', 'custom env must be forwarded');
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
      await rm(logFile, { force: true });
    }
  });

  it('detached pgid equality (child pgid == pid)', async () => {
    const logFile = join(tmpdir(), `pgid-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    await writeFile(logFile, '', 'utf8');
    const registryPath = await tempRegistryPath();
    const dir = await mkdtemp(join(tmpdir(), 'bridge-task-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, 'pgid check', 'utf8');
    try {
      await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_LOG: logFile },
      });
      const raw = await readFile(logFile, 'utf8');
      const info = JSON.parse(raw.trim().split('\n').pop());
      assert.equal(info.pgid, info.pid, 'detached process pgid must equal pid (new process group)');
    } finally {
      await rmTestDir(dir);
      await cleanupRegistry(registryPath);
      await rm(logFile, { force: true });
    }
  });
});

describe('envelope', () => {
  it('validateEnvelope rejects bad shapes', () => {
    assert.equal(validateEnvelope(null).valid, false);
    assert.equal(validateEnvelope({ v: 1 }).valid, false);
    assert.equal(
      validateEnvelope({ v: 1, runId: 'x', sessionId: null, status: 'completed', result: 123 }).valid,
      false,
    );
    assert.equal(validateEnvelope({ v: 1, runId: 'x', sessionId: null, status: 'need_input' }).valid, false);
    assert.equal(
      validateEnvelope({ v: 1, runId: 'x', sessionId: null, status: 'error', error: { code: '', message: '' } }).valid,
      false,
    );
  });

  it('tryParseEnvelopeFromStdout finds last line', () => {
    const env = { v: 1, runId: 'r1', sessionId: null, status: 'completed', result: 'hi' };
    const stdout = `hello\nworld\n${JSON.stringify(env)}\n`;
    const parsed = tryParseEnvelopeFromStdout(stdout);
    assert.ok(parsed.envelope);
    assert.equal(parsed.envelope.result, 'hi');
  });

  it('tryParseEnvelopeFromStdout returns none when no envelope', () => {
    const parsed = tryParseEnvelopeFromStdout('just text\nmore text\n');
    assert.equal(parsed.none, true);
  });

  it('tryParseEnvelopeFromStdout marks malformed when v1 shape invalid', () => {
    const bad = `${JSON.stringify({ v: 1, runId: 'r' })}\n`;
    const parsed = tryParseEnvelopeFromStdout(`out\n${bad}`);
    assert.equal(parsed.malformed, true);
  });
});
