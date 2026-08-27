import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  startDsh,
  killRun,
  waitRun,
  sendToRun,
  pollRun,
  reapExpiredRuns,
  sweepRuns,
  expiryReasonOf,
  renewLease,
  DEFAULT_LEASE_MS,
} from '../src/async-run.js';
import { runDsh } from '../src/run.js';
import { getRun, updateRun, isPidAlive } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunInState, waitRunSettled } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRun(task = '__FAKE_HANG__', startOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'watchdog-'));
  const registryPath = join(dir, 'runs.json');
  const taskFile = join(dir, 'task.txt');
  await writeFile(taskFile, task, 'utf8');
  const handle = await startDsh({
    taskFile,
    cwd: dir,
    registryPath,
    timeoutMs: 60000,
    env: { DSH_BINARY: FIXTURE_DSH },
    ...startOpts,
  });
  return {
    dir,
    registryPath,
    handle,
    async cleanup() {
      try {
        await killRun(handle.runId, { registryPath, graceMs: 300 });
      } catch {}
      await rmTestDir(dir);
    },
  };
}

/** Сдвигает срок в прошлое — эмулирует «владелец давно не появлялся». */
const past = (ms = 1000) => new Date(Date.now() - ms).toISOString();

describe('аренда владельца (owner lease)', () => {
  it('startDsh проставляет leaseUntil и deadlineAt', async () => {
    const ctx = await withRun();
    try {
      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.ok(entry.leaseUntil, 'leaseUntil должен быть в записи');
      assert.ok(entry.deadlineAt, 'deadlineAt должен быть в записи');
      const lease = Date.parse(entry.leaseUntil);
      assert.ok(lease > Date.now(), 'аренда выдана в будущее');
      // Дедлайн рана считается от timeoutMs, аренда — от DEFAULT_LEASE_MS.
      assert.equal(Date.parse(entry.deadlineAt) - Date.parse(entry.startedAt), 60000);
      assert.ok(Math.abs(lease - Date.parse(entry.startedAt) - DEFAULT_LEASE_MS) < 2000);
    } finally {
      await ctx.cleanup();
    }
  });

  it('waitRun продлевает аренду: владелец жив, пока ждёт', async () => {
    const ctx = await withRun();
    try {
      await updateRun(ctx.handle.runId, { leaseUntil: past() }, ctx.registryPath);
      await waitRun(ctx.handle.runId, { waitMs: 0, registryPath: ctx.registryPath });
      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.ok(Date.parse(entry.leaseUntil) > Date.now(), 'ожидание продлевает аренду');
    } finally {
      await ctx.cleanup();
    }
  });

  it('sendToRun продлевает аренду', async () => {
    const ctx = await withRun();
    try {
      await updateRun(ctx.handle.runId, { leaseUntil: past() }, ctx.registryPath);
      await sendToRun(ctx.handle.runId, 'уточнение', { registryPath: ctx.registryPath });
      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.ok(Date.parse(entry.leaseUntil) > Date.now(), 'steering продлевает аренду');
    } finally {
      await ctx.cleanup();
    }
  });

  it('pollRun аренду НЕ продлевает: смотреть — не владеть', async () => {
    const ctx = await withRun();
    try {
      const stale = past();
      await updateRun(ctx.handle.runId, { leaseUntil: stale }, ctx.registryPath);
      await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.equal(entry.leaseUntil, stale, 'dsh_list не должен воскрешать аренду');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('reapExpiredRuns', () => {
  it('убивает ран с истёкшей арендой и оставляет объясняющий envelope', async () => {
    const ctx = await withRun();
    try {
      const pid = ctx.handle.pid;
      assert.equal(isPidAlive(pid), true, 'ран должен быть жив до зачистки');

      await updateRun(ctx.handle.runId, { leaseUntil: past() }, ctx.registryPath);
      const res = await reapExpiredRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.killed, [ctx.handle.runId]);

      const after = await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(after.state, 'error');
      assert.equal(after.envelope.error.code, 'owner_gone');
      assert.equal(isPidAlive(pid), false, 'процесс DSH не должен пережить владельца');
    } finally {
      await ctx.cleanup();
    }
  });

  it('убивает ран, переживший свой дедлайн, даже без живого таймера', async () => {
    const ctx = await withRun();
    try {
      const pid = ctx.handle.pid;
      await updateRun(ctx.handle.runId, { deadlineAt: past() }, ctx.registryPath);
      const res = await reapExpiredRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.killed, [ctx.handle.runId]);

      const after = await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(after.envelope.error.code, 'deadline_exceeded');
      assert.equal(isPidAlive(pid), false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('живой ран со свежей арендой не трогает', async () => {
    const ctx = await withRun();
    try {
      const res = await reapExpiredRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.killed, []);
      assert.equal(isPidAlive(ctx.handle.pid), true);
      const after = await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(after.state, 'running');
    } finally {
      await ctx.cleanup();
    }
  });

  it('запись старого формата без сроков не убивает: молчание — не повод', async () => {
    const ctx = await withRun();
    try {
      await updateRun(ctx.handle.runId, { leaseUntil: null, deadlineAt: null }, ctx.registryPath);
      const res = await reapExpiredRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.killed, []);
      assert.equal(isPidAlive(ctx.handle.pid), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('завершённый ран не убивает повторно и не переписывает его envelope', async () => {
    const ctx = await withRun('__FAKE_ENVELOPE_OK__ короткая задача');
    try {
      const done = await waitRunInState(ctx.handle.runId, 'completed', {
        waitMs: 10000,
        registryPath: ctx.registryPath,
      });
      assert.equal(done.state, 'completed');

      await updateRun(ctx.handle.runId, { leaseUntil: past() }, ctx.registryPath);
      const res = await reapExpiredRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.killed, []);

      const after = await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(after.state, 'completed', 'готовый результат не должен превращаться в ошибку');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('атомарный claim в reapExpiredRuns (P0, дефект 2, раунд 2 кросс-ревью)', () => {
  // Старый код решал по снимку (listRuns) и звал killRun вне транзакции:
  // renewLease между снимком и kill продлевал аренду, но живой ран всё равно
  // убивался. Claim под тем же локом, что и перечитывание записи, обязан
  // отказать, если аренду успели продлить раньше claim.
  it('гонка claim vs renewLease: продление между снимком и claim спасает живой ран', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-claim-race-'));
    const registryPath = join(dir, 'runs.json');
    let h1 = null;
    let h2 = null;
    try {
      const taskFile1 = join(dir, 'task1.txt');
      const taskFile2 = join(dir, 'task2.txt');
      // h1 игнорирует SIGTERM — его kill растягивается почти на весь graceMs
      // (полная эскалация до SIGKILL), давая время renewLease(h2) сработать
      // ДО того, как цикл reapExpiredRuns дойдёт до claim по h2 (порядок
      // кандидатов — порядок вставки ключей реестра, h1 первый).
      await writeFile(taskFile1, '__FAKE_IGNORE_TERM__', 'utf8');
      await writeFile(taskFile2, '__FAKE_HANG__', 'utf8');

      h1 = await startDsh({
        taskFile: taskFile1,
        cwd: dir,
        registryPath,
        timeoutMs: 60000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      h2 = await startDsh({
        taskFile: taskFile2,
        cwd: dir,
        registryPath,
        timeoutMs: 60000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      // Прогрев: startDsh резолвится сразу после putRun, а не после того, как
      // h1 реально дошёл до своего process.on('SIGTERM', noop) — интерпретатору
      // node ещё нужно стартовать (shell exec + V8 init). Без паузы SIGTERM от
      // reapExpiredRuns может прилететь РАНЬШЕ регистрации обработчика, и
      // сработает дефолтная диспозиция (завершение) — h1 умрёт мгновенно, а не
      // после полного grace, ломая весь смысл теста (см. отчёт).
      await sleep(150);

      await updateRun(h1.runId, { leaseUntil: past() }, registryPath);
      await updateRun(h2.runId, { leaseUntil: past() }, registryPath);

      const renewSoon = sleep(80).then(() => renewLease(h2.runId, { registryPath }));
      const res = await reapExpiredRuns(registryPath, { graceMs: 400 });
      await renewSoon;

      assert.ok(res.killed.includes(h1.runId), 'h1 был по-настоящему просрочен и должен быть убит');
      assert.ok(!res.killed.includes(h2.runId), 'h2 должен был уцелеть: аренду продлили раньше claim');
      assert.equal(isPidAlive(h2.pid), true, 'claim обязан был отказать после renewLease — h2 остаётся жив');

      const entry2 = await getRun(h2.runId, registryPath);
      assert.equal(entry2.state, 'running', 'запись h2 должна остаться running, а не reaping');
    } finally {
      if (h1) await killRun(h1.runId, { registryPath, graceMs: 300 }).catch(() => {});
      if (h2) await killRun(h2.runId, { registryPath, graceMs: 300 }).catch(() => {});
      await rmTestDir(dir);
    }
  });

  it('после claim (state:"reaping" проставлен вручную) renewLease отказывает и не трогает leaseUntil', async () => {
    const ctx = await withRun();
    try {
      const before = past();
      await updateRun(ctx.handle.runId, { leaseUntil: before, state: 'reaping' }, ctx.registryPath);

      const result = await renewLease(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(
        result,
        null,
        'renewLease не должен продлевать запись не в состоянии running — каноничный отказ после claim',
      );

      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.equal(entry.leaseUntil, before, 'leaseUntil не должен был измениться после отказа');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('sweepRuns', () => {
  it('за один проход добивает просроченный ран и вычищает его запись', async () => {
    const ctx = await withRun();
    try {
      const pid = ctx.handle.pid;
      await updateRun(ctx.handle.runId, { leaseUntil: past() }, ctx.registryPath);

      const res = await sweepRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.expired, [ctx.handle.runId]);
      assert.ok(res.removed.includes(ctx.handle.runId), 'запись завершённого рана уходит из реестра');
      assert.equal(isPidAlive(pid), false);

      // Реестр пуст, но результат не потерян: envelope остался на диске.
      assert.equal(await getRun(ctx.handle.runId, ctx.registryPath), null);
      const after = await pollRun(ctx.handle.runId, { registryPath: ctx.registryPath });
      assert.equal(after.envelope.error.code, 'owner_gone');
    } finally {
      await ctx.cleanup();
    }
  });

  it('живой ран со свежей арендой переживает подметание', async () => {
    const ctx = await withRun();
    try {
      const res = await sweepRuns(ctx.registryPath, { graceMs: 300 });
      assert.deepEqual(res.expired, []);
      assert.equal(isPidAlive(ctx.handle.pid), true);
      assert.ok(await getRun(ctx.handle.runId, ctx.registryPath), 'запись живого рана не трогаем');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('синхронный путь (dsh_task) — тот же detached-процесс', () => {
  it('runDsh пишет дедлайн, но не аренду: продлевать её здесь некому', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-sync-'));
    const registryPath = join(dir, 'runs.json');
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_ENVELOPE_OK__ короткая задача', 'utf8');

    // Реестр читаем на лету: синхронный путь удаляет запись по завершении.
    let seen = null;
    const poll = setInterval(async () => {
      if (seen) return;
      try {
        const reg = JSON.parse(await readFile(registryPath, 'utf8'));
        const entry = Object.values(reg)[0];
        if (entry) seen = entry;
      } catch {}
    }, 5);

    try {
      await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 45000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      clearInterval(poll);
      assert.ok(seen, 'запись должна была появиться в реестре во время рана');
      assert.ok(seen.deadlineAt, 'дедлайн обязателен: владелец может умереть во время ожидания');
      assert.equal(Date.parse(seen.deadlineAt) - Date.parse(seen.startedAt), 45000);
      assert.equal(seen.leaseUntil, null, 'аренды на блокирующем пути быть не должно');
      assert.equal(expiryReasonOf(seen, Date.parse(seen.startedAt) + 1000), null);
      assert.equal(expiryReasonOf(seen, Date.parse(seen.deadlineAt) + 1), 'deadline_exceeded');
    } finally {
      clearInterval(poll);
      await rmTestDir(dir);
    }
  });
});

describe('сквозной runId в окружении рана', () => {
  it('startDsh кладёт DSH_RUN_ID и DSH_STEER_FILE в окружение процесса', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runid-'));
    const registryPath = join(dir, 'runs.json');
    const taskFile = join(dir, 'task.txt');
    // Фикстура по этой задаче печатает своё окружение в лог.
    await writeFile(taskFile, '__FAKE_DUMP_ENV__', 'utf8');
    try {
      const h = await startDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 20000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      await waitRunSettled(h.runId, { waitMs: 10000, registryPath });
      const log = await readFile(h.logFile, 'utf8');
      assert.match(log, new RegExp(`DSH_RUN_ID=${h.runId}`), 'раннер должен получить тот же runId, что вернул spawn');
      assert.match(log, /DSH_STEER_FILE=.*\.steer\.jsonl/);
    } finally {
      await rmTestDir(dir);
    }
  });
});

describe('сквозной runId на синхронном пути', () => {
  it('runDsh тоже передаёт DSH_RUN_ID раннеру', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runid-sync-'));
    const registryPath = join(dir, 'runs.json');
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_DUMP_ENV__', 'utf8');
    try {
      const envelope = await runDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 20000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      // Синхронный путь возвращает envelope, синтезированный из stdout фикстуры.
      assert.match(envelope.result ?? '', new RegExp(`DSH_RUN_ID=${envelope.runId}`));
    } finally {
      await rmTestDir(dir);
    }
  });
});
