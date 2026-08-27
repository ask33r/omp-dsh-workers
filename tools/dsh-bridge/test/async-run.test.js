import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { startDsh, pollRun, waitRun, killRun, readRunOutput, isPidAlive, putRun } from '../src/index.js';
// __testOnly_getActiveRun — НЕ часть публичного API (не реэкспортируется из
// index.js намеренно, см. комментарий в async-run.js), импортируется из
// src напрямую только этим тестом раунда 3 (окно close→activeRuns.delete).
import { __testOnly_getActiveRun } from '../src/async-run.js';
import { killTestProcess } from './kill-safe.js';
import { rmTestDir } from './tmp-cleanup.js';
import { describeRun, waitRunInState, waitRunSettled } from './wait-helpers.js';

const FIXTURES_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Изолированный тестовый каталог: registryPath живёт ВНУТРИ testDir/var, поэтому
// runPaths() кладёт var/runs/*.{log,envelope.json} тоже внутри testDir — единственный
// rmTestDir(testDir) подчищает реестр, логи и envelope-файлы разом.
async function makeTestDir() {
  const testDir = await mkdtemp(join(tmpdir(), 'async-bridge-'));
  const registryPath = join(testDir, 'var', 'runs.json');
  return { testDir, registryPath, cwd: testDir };
}

async function writeTask(testDir, text) {
  const taskFile = join(testDir, 'task.txt');
  await writeFile(taskFile, text, 'utf8');
  return taskFile;
}

async function cleanup(testDir) {
  await rmTestDir(testDir).catch(() => {});
}

// Гарантирует, что ран остановлен и envelope финализирован, даже если тест упал
// раньше собственной уборки — чтобы не оставлять живых процессов после суита.
async function ensureStopped(runId, registryPath) {
  try {
    await killRun(runId, { registryPath, graceMs: 500 });
  } catch {}
}

describe('bridge-core async API (contract v2)', () => {
  // Строка 1: startDsh возвращается до завершения рана — промис резолвится, пока pid жив.
  it('startDsh resolves before the run finishes and returns a live RunHandle', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ row1');
      const t0 = Date.now();
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });
      const elapsed = Date.now() - t0;

      assert.ok(handle.runId, 'runId present');
      assert.ok(Number.isInteger(handle.pid) && handle.pid > 1, 'pid present and safe');
      assert.ok(Number.isInteger(handle.pgid) && handle.pgid > 1, 'pgid present and safe');
      assert.ok(handle.logFile, 'logFile present');
      assert.ok(handle.startedAt, 'startedAt present');
      assert.ok(elapsed < 3000, `startDsh must return quickly (not wait for exit), took ${elapsed}ms`);
      assert.equal(isPidAlive(handle.pid), true, 'process must still be alive right after start');

      await ensureStopped(handle.runId, registryPath);
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 2: pollRun во время рана -> state:"running", envelope:null.
  it('pollRun during a running run reports running/null', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ row2');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const p = await pollRun(handle.runId, { registryPath });
      assert.equal(p.runId, handle.runId);
      assert.equal(p.state, 'running');
      assert.equal(p.envelope, null);
      assert.equal(p.exitCode, null);

      await ensureStopped(handle.runId, registryPath);
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 3: waitRun с коротким waitMs на долгом ране -> state:"running", ран жив после возврата.
  it('waitRun with a short waitMs on a long run returns running and leaves the run alive', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ row3');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const t0 = Date.now();
      const r = await waitRun(handle.runId, { waitMs: 200, registryPath });
      const elapsed = Date.now() - t0;

      assert.equal(r.state, 'running');
      assert.equal(r.envelope, null);
      assert.ok(elapsed >= 180, `waitRun must actually wait ~waitMs, took ${elapsed}ms`);
      assert.ok(elapsed < 2000, `waitRun must not overshoot waitMs badly, took ${elapsed}ms`);
      assert.equal(isPidAlive(handle.pid), true, 'run must still be alive after waitMs elapses');

      await ensureStopped(handle.runId, registryPath);
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 4: waitRun дожидается завершения -> корректный envelope, exitCode.
  it('waitRun waits for completion and returns the forwarded envelope with exitCode', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_ENVELOPE_OK__ hello async');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const r = await waitRunInState(handle.runId, 'completed', { waitMs: 3000, registryPath });
      assert.equal(r.state, 'completed');
      assert.ok(r.envelope, 'envelope present');
      assert.equal(r.envelope.v, 1);
      assert.equal(r.envelope.status, 'completed');
      assert.equal(r.envelope.result, 'hello async');
      assert.equal(r.exitCode, 0);

      // Повторный опрос после завершения — идемпотентно читает тот же envelope.
      const p2 = await pollRun(handle.runId, { registryPath });
      assert.deepEqual(p2.envelope, r.envelope);
      assert.equal(p2.exitCode, 0);
    } finally {
      await cleanup(testDir);
    }
  });

  // Дефект 5 кросс-ревью: envelope с ЧУЖИМ runId (эхо/подделка задачей) не
  // должен приниматься как есть — задача могла напечатать чужой runId,
  // случайно или намеренно, и владелец другого рана получил бы не свой результат.
  it('envelope с чужим runId — malformed_output, а не тихая подмена результата', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_ENVELOPE_OK__ чужой ответ');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_ENVELOPE_RUNID: 'some-other-run-id' },
      });

      const r = await waitRunInState(handle.runId, 'error', { waitMs: 3000, registryPath });
      assert.equal(r.state, 'error');
      assert.ok(r.envelope);
      assert.equal(r.envelope.status, 'error');
      assert.equal(r.envelope.error.code, 'malformed_output', `код ошибки не тот: ${describeRun(r)}`);
      assert.match(r.envelope.error.message, /runId mismatch/);
      assert.match(r.envelope.error.message, /got some-other-run-id/);
      assert.match(r.envelope.error.message, new RegExp(`expected ${handle.runId}`));
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 5: readRunOutput с offset -> байты без потерь и дублей при последовательных чтениях.
  it('readRunOutput streams bytes without loss or duplication across sequential reads', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const bigText = `line-${'A'.repeat(4000)}${'\nsecond line\nthird — unicode café 🌟\n'.repeat(20)}END`;
      const taskFile = await writeTask(testDir, bigText);
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const done = await waitRunInState(handle.runId, 'completed', { waitMs: 3000, registryPath });
      assert.equal(done.state, 'completed');

      let offset = 0;
      let collected = Buffer.alloc(0);
      let iterations = 0;
      for (;;) {
        iterations++;
        assert.ok(iterations < 10000, 'must not loop forever');
        const { chunk, nextOffset, eof } = await readRunOutput(handle.runId, {
          offset,
          maxBytes: 777,
          registryPath,
        });
        assert.ok(nextOffset >= offset, 'nextOffset must not go backwards');
        collected = Buffer.concat([collected, Buffer.from(chunk, 'utf8')]);
        offset = nextOffset;
        if (eof) break;
      }

      // fake-dsh echoes: process.stdout.write(task + '\n')
      assert.equal(collected.toString('utf8'), `${bigText}\n`);

      // Повторное чтение с offset=0 должно вернуть тот же самый префикс (без дублей/потерь
      // при пересечении диапазонов — проверяем на меньшем шаге вручную).
      const again = await readRunOutput(handle.runId, { offset: 0, maxBytes: 10, registryPath });
      assert.equal(again.chunk, collected.toString('utf8').slice(0, 10));
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 6: killRun во время рана -> группа мертва, state не "running".
  it('killRun during a run kills the whole process group and clears running state', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_SPAWN_CHILD__ row6');
      const childLogFile = join(testDir, 'child.pid');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_CHILD_LOG: childLogFile },
      });

      // дать фейковому dsh время реально породить вложенный sleep-child
      await sleep(200);

      const res = await killRun(handle.runId, { registryPath, graceMs: 1500 });
      assert.equal(res.runId, handle.runId);
      assert.equal(res.killed, true, 'killRun must report it actually signalled the group');
      assert.equal(res.state, 'error');
      assert.equal(isPidAlive(handle.pid), false, 'leader pid must be dead after killRun');

      let childPid = null;
      try {
        childPid = parseInt(await readFile(childLogFile, 'utf8'), 10);
      } catch {}
      if (childPid) {
        assert.equal(isPidAlive(childPid), false, `nested child pid ${childPid} must be dead (pgid kill)`);
      }

      const p = await pollRun(handle.runId, { registryPath });
      assert.notEqual(p.state, 'running');
      assert.equal(p.envelope.status, 'error');
      assert.equal(p.envelope.error.code, 'killed', `код ошибки не тот: ${describeRun(p)}`);

      // Идемпотентность: повторный killRun на уже мёртвом ране — no-op.
      const res2 = await killRun(handle.runId, { registryPath });
      assert.equal(res2.killed, false);
      assert.equal(res2.state, 'error');
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 7: ран пережил смерть наблюдателя -> pollRun синтезирует error/killed, не виснет.
  it('pollRun synthesizes error/killed when the run outlived its observer (dead pid, no envelope)', async () => {
    const { testDir, registryPath } = await makeTestDir();
    try {
      // Гарантированно мёртвый pid: реальный процесс, дождались его собственного выхода.
      const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      const deadPid = proc.pid;
      await new Promise((res) => proc.once('close', res));
      assert.equal(isPidAlive(deadPid), false, 'sanity: helper process must be dead by now');

      const runId = 'orphan-observer-row7';
      // Реестровая запись как если бы startDsh() отработал, но процесс-наблюдатель
      // (тот, что вызвал startDsh) умер раньше, чем dsh завершился и записал envelope.
      await putRun(
        runId,
        {
          pid: deadPid,
          pgid: deadPid,
          dshSessionId: null,
          state: 'running',
          startedAt: new Date().toISOString(),
          cwd: testDir,
        },
        registryPath,
      );

      const t0 = Date.now();
      const p = await pollRun(runId, { registryPath });
      const elapsed = Date.now() - t0;

      assert.ok(elapsed < 2000, `pollRun must not hang, took ${elapsed}ms`);
      assert.equal(p.state, 'error');
      assert.ok(p.envelope);
      assert.equal(p.envelope.status, 'error');
      assert.equal(p.envelope.error.code, 'killed', `код ошибки не тот: ${describeRun(p)}`);

      // Второй вызов идемпотентно читает уже финализированный envelope.
      const p2 = await pollRun(runId, { registryPath });
      assert.deepEqual(p2.envelope, p.envelope);
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 8 (bridge-core аналог "dsh_wait таймаут"): истёкший waitMs — не ошибка,
  // ран продолжает жить, последующий waitRun дожидается его фактического завершения.
  it('waitRun timeout is not an error; a later waitRun observes the eventual resolution', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ row8');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const r1 = await waitRun(handle.runId, { waitMs: 150, registryPath });
      assert.equal(r1.state, 'running');
      assert.equal(isPidAlive(handle.pid), true, 'run must stay alive after a wait timeout');

      // Планируем завершение рана (killRun) параллельно со вторым, более длинным wait —
      // второй waitRun обязан реально дождаться и вернуть разрешённое состояние.
      const killPromise = sleep(150).then(() => killRun(handle.runId, { registryPath }));
      const t0 = Date.now();
      const r2 = await waitRunSettled(handle.runId, { waitMs: 3000, registryPath });
      const elapsed = Date.now() - t0;
      await killPromise;

      assert.notEqual(r2.state, 'running', 'second waitRun must observe resolution, not another timeout');
      assert.ok(r2.envelope);
      assert.ok(elapsed < 3000, 'second waitRun must return as soon as the run resolves, not wait the full budget');
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 9: AbortSignal у waitRun — ожидание прервано, ран НЕ убит.
  it('AbortSignal on waitRun cancels only the wait; the run itself is not killed', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ row9');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 150);
      timer.unref();

      const t0 = Date.now();
      const r = await waitRun(handle.runId, { waitMs: 5000, registryPath, signal: ac.signal });
      const elapsed = Date.now() - t0;
      clearTimeout(timer);

      assert.ok(elapsed < 1500, `abort must cut the wait short well before waitMs, took ${elapsed}ms`);
      assert.equal(r.state, 'running');
      assert.equal(isPidAlive(handle.pid), true, 'AbortSignal must not kill the run');

      await ensureStopped(handle.runId, registryPath);
    } finally {
      await cleanup(testDir);
    }
  });

  // Строка 10: timeoutMs рана истёк -> envelope error/timeout, группа убита.
  it('run timeoutMs expiry produces error/timeout and kills the whole group', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_SPAWN_CHILD__ row10');
      const childLogFile = join(testDir, 'child.pid');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 300,
        env: { DSH_BINARY: FIXTURES_DSH, FAKE_DSH_CHILD_LOG: childLogFile },
      });

      const r = await waitRunInState(handle.runId, 'error', { waitMs: 3000, registryPath });
      assert.equal(r.state, 'error');
      assert.ok(r.envelope);
      assert.equal(r.envelope.status, 'error');
      assert.equal(r.envelope.error.code, 'timeout', `код ошибки не тот: ${describeRun(r)}`);
      assert.equal(isPidAlive(handle.pid), false);

      await sleep(300); // дать SIGKILL-эскалации отработать для вложенного child
      let childPid = null;
      try {
        childPid = parseInt(await readFile(childLogFile, 'utf8'), 10);
      } catch {}
      if (childPid) {
        assert.equal(isPidAlive(childPid), false, `nested child pid ${childPid} must be dead after timeout kill`);
      }
    } finally {
      await cleanup(testDir);
    }
  });

  // Раунд 3 кросс-ревью (блокер Codex): таймер SIGKILL-эскалации у startDsh
  // раньше переживал close — close-хендлер чистил только timeoutHandle, а
  // ссылка на escalate-таймер вообще нигде не сохранялась и не отменялась.
  // На фикстуре, которая честно умирает от SIGTERM (__FAKE_HANG__), эскалация
  // не нужна вовсе, но таймер всё равно был заведён и висел ~500мс, целясь по
  // номеру pid, который к этому моменту уже мог достаться другому процессу.
  // Тест: дождаться timeout-исхода, затем пережить окно эскалации (>500мс) и
  // убедиться, что ничего не падает и повторный опрос стабилен.
  it('startDsh: escalation timer is cancelled on close and never fires afterwards', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ escalation-not-needed');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 300,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const r = await waitRunInState(handle.runId, 'error', { waitMs: 3000, registryPath });
      assert.equal(r.state, 'error');
      assert.ok(r.envelope);
      assert.equal(r.envelope.error.code, 'timeout', `код ошибки не тот: ${describeRun(r)}`);
      assert.equal(isPidAlive(handle.pid), false, 'SIGTERM already killed the fixture, no escalation needed');

      // Окно эскалационного таймера (500мс) + запас. Если он не был отменён в
      // close-хендлере, он сработал бы здесь — с текущим кодом это безопасный
      // guard (flags.closed), но сам факт срабатывания старого таймера на уже
      // завершённом ране — то, чего быть не должно в принципе.
      await sleep(650);

      const p2 = await pollRun(handle.runId, { registryPath });
      assert.deepEqual(p2.envelope, r.envelope, 'повторный опрос после окна эскалации стабилен');

      assert.deepEqual(unhandled, [], `unexpected unhandledRejection(s): ${unhandled.map(String).join('; ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      await cleanup(testDir);
    }
  });

  // Раунд 3: на фикстуре, которая SIGTERM ИГНОРИРУЕТ (__FAKE_IGNORE_TERM__),
  // эскалация обязана реально сработать — единственный способ завершить ран.
  it('startDsh: escalation kills a SIGTERM-ignoring process before close', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_IGNORE_TERM__ needs-sigkill');
      const t0 = Date.now();
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 300,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const r = await waitRunInState(handle.runId, 'error', { waitMs: 3000, registryPath });
      const elapsed = Date.now() - t0;

      assert.equal(r.state, 'error');
      assert.equal(r.envelope.error.code, 'timeout', `код ошибки не тот: ${describeRun(r)}`);
      assert.equal(isPidAlive(handle.pid), false, 'process ignoring SIGTERM must be dead via SIGKILL escalation');
      assert.ok(elapsed < 3000, `escalation must resolve well within the wait budget, took ${elapsed}ms`);
    } finally {
      await cleanup(testDir);
    }
  });

  // Раунд 3 кросс-ревью (блокер Codex): локальный killRun раньше мерил grace
  // против donePromise (готовность envelope, включает I/O записи на диск), а
  // не против фактического выхода процесса — на SIGTERM-игнорирующей задаче
  // SIGKILL всё равно долетал бы (donePromise никогда не резолвится без него),
  // но сам факт, что grace измерял не то, что заявлено в контракте, был багом
  // независимо от исхода. Тест проверяет наблюдаемый результат: убит в
  // пределах grace + разумный запас.
  it('killRun (local): kills a SIGTERM-ignoring process within grace via SIGKILL escalation', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_IGNORE_TERM__ kill-me-hard');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      await sleep(100); // дать фикстуре реально поставить SIGTERM-обработчик

      const graceMs = 500;
      const t0 = Date.now();
      const res = await killRun(handle.runId, { registryPath, graceMs });
      const elapsed = Date.now() - t0;

      assert.equal(res.runId, handle.runId);
      assert.equal(res.state, 'error');
      assert.equal(
        isPidAlive(handle.pid),
        false,
        'process ignoring SIGTERM must be dead after killRun escalates to SIGKILL',
      );
      assert.ok(elapsed < graceMs + 2500, `killRun must finish within grace + escalation budget, took ${elapsed}ms`);

      const p = await pollRun(handle.runId, { registryPath });
      assert.notEqual(p.state, 'running');
      assert.equal(p.envelope.status, 'error');
    } finally {
      await cleanup(testDir);
    }
  });

  // Раунд 3: на процессе, который честно умирает от первого SIGTERM, ветка
  // SIGKILL вообще не должна выполняться — killRun обязан вернуться заметно
  // раньше graceMs, а killed:true должен идти от самого первого SIGTERM.
  it('killRun (local): a fast-dying process returns well before graceMs without escalating', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ dies-on-first-term');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      await sleep(100);

      const graceMs = 1500;
      const t0 = Date.now();
      const res = await killRun(handle.runId, { registryPath, graceMs });
      const elapsed = Date.now() - t0;

      assert.equal(res.killed, true, 'killed:true must come from the first SIGTERM');
      assert.equal(res.state, 'error');
      assert.ok(
        elapsed < graceMs / 2,
        `killRun on a process that dies immediately must return well before graceMs (${graceMs}ms), took ${elapsed}ms`,
      );
    } finally {
      await cleanup(testDir);
    }
  });

  // Раунд 3 кросс-ревью, п.4 (скоуп расширен координатором): окно между
  // началом close-хендлера (flags.closed=true, его первая строка) и
  // activeRuns.delete (после finalizeIfAbsent, то есть после I/O) — запись
  // ещё жива в activeRuns, но процесс уже вышел, и слать ему сигнал больше
  // нельзя (то же правило "no signals after close", что и у отложенной
  // SIGKILL-эскалации). Снаружи это окно — гонка с реальным I/O длиной в
  // единицы миллисекунд, ловить её через sleep() ненадёжно и дало бы flaky-
  // тест. Вместо этого детерминированно ВОСПРОИЗВОДИМ целевое состояние через
  // __testOnly_getActiveRun: берём фикстуру, которая гарантированно ещё жива
  // (__FAKE_HANG__, настоящий close не наступит без сигнала), и вручную
  // выставляем flags.closed=true — ровно то состояние, которое guard обязан
  // распознать. Если guard сломан, killRun пошлёт killPgid/killPid, и
  // фикстура (которая честно умирает от SIGTERM) умрёт — это наблюдаемо и
  // однозначно отличает "guard сработал" от "guard дыряв".
  it('killRun (local): closed-but-not-yet-deleted entry — no signal is sent, honest killed:false', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    // Объявлен ДО try: finally обязан суметь глушить процесс напрямую даже
    // если startDsh уже вернул handle, а что-то ПОСЛЕ него бросило (handle,
    // объявленный внутри try через const/let, был бы не виден в finally).
    let handle;
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ closed-window');
      handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      const local = __testOnly_getActiveRun(handle.runId);
      assert.ok(local, 'sanity: активная запись должна быть в activeRuns сразу после startDsh');
      assert.equal(local.flags.closed, false, 'sanity: настоящий close ещё не наступил');

      // Имитируем окно: close "уже начался" с точки зрения guard'а, реальный
      // процесс при этом остаётся живым и висит (donePromise поэтому НЕ
      // резолвится сам по себе — killRun упрётся в bounded-таймаут и уйдёт в
      // fallback, как и описано в фиксе).
      local.flags.closed = true;

      const res = await killRun(handle.runId, { registryPath, graceMs: 500 });

      assert.equal(res.runId, handle.runId);
      assert.equal(res.killed, false, 'guard обязан вернуть killed:false — сигнал не посылался');
      assert.equal(res.state, 'error');
      assert.equal(
        isPidAlive(handle.pid),
        true,
        'процесс должен остаться ЖИВ: guard не должен был слать killPgid/killPid вообще',
      );

      assert.deepEqual(unhandled, [], `unexpected unhandledRejection(s): ${unhandled.map(String).join('; ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      // Настоящий close для этой фикстуры не наступит сам — глушим напрямую,
      // в обход bridge API (killRun теперь идемпотентно вернёт killed:false
      // из-за уже написанного envelope, см. ensureStopped/killRun выше).
      // killTestProcess, а не process.kill напрямую: handle приходит из
      // startDsh, и если тот подменён утёкшим mock.module (голый `bun test`),
      // то pgid === 1, а kill(-1) — не «группа 1», а broadcast всем процессам
      // пользователя. Гарды isSafePgid/isSafePid внутри хелпера это отсекают.
      if (handle) killTestProcess(handle.pid, handle.pgid, 'SIGKILL');
      await cleanup(testDir);
    }
  });
});
