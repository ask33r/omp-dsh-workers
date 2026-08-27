import './node-only.js';

// Identity процесса против переиспользования PID (P1, дефект 3 кросс-ревью):
// kill по реестровым pid/pgid может попасть в ЧУЖОЙ процесс, если ОС успела
// переиспользовать номер между тем, как наш процесс умер, и тем, как реестр
// об этом узнал. procStarttime (поле 22 из /proc/<pid>/stat) — дешёвый способ
// проверить identity: у переиспользованного номера starttime другой.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { startDsh, killRun, pollRun } from '../src/async-run.js';
import { runDsh } from '../src/run.js';
import { rmTestDir } from './tmp-cleanup.js';
import {
  getRun,
  readRegistry,
  writeRegistry,
  readProcStarttime,
  isPidAlive,
  killPgid,
  killPid,
  putRun,
  updateRun,
} from '../src/registry.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

async function ctx() {
  const dir = await mkdtemp(join(tmpdir(), 'pid-identity-'));
  return {
    dir,
    registryPath: join(dir, 'runs.json'),
    async run(task, extra = {}) {
      const taskFile = join(this.dir, `task-${Math.abs(task.length)}-${Object.keys(extra).length}.txt`);
      await writeFile(taskFile, task, 'utf8');
      return startDsh({
        taskFile,
        cwd: this.dir,
        registryPath: this.registryPath,
        timeoutMs: 20000,
        env: { DSH_BINARY: FIXTURE_DSH },
        ...extra,
      });
    },
    async cleanup() {
      await rmTestDir(this.dir);
    },
  };
}

describe('procStarttime — identity процесса против переиспользования PID', () => {
  it('startDsh пишет procStarttime в запись, и он совпадает с реальным /proc/<pid>/stat', async () => {
    const c = await ctx();
    const h = await c.run('__FAKE_HANG__');
    try {
      const entry = await getRun(h.runId, c.registryPath);
      assert.ok(
        typeof entry.procStarttime === 'string' && entry.procStarttime !== '',
        'procStarttime должен быть записан при спавне',
      );
      assert.equal(entry.procStarttime, readProcStarttime(h.pid), 'должен совпадать с текущим /proc/<pid>/stat');
    } finally {
      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
      await c.cleanup();
    }
  });

  it('подменённый procStarttime у живого рана: кросс-процессный killRun НЕ трогает чужой процесс', async () => {
    const c = await ctx();
    let pid = null;
    try {
      // Спавним процесс НАПРЯМУЮ через putRun, В ОБХОД startDsh: если бы ран
      // стартовал startDsh() в ЭТОМ же процессе, killRun нашёл бы его в
      // activeRuns и ушёл бы по локальному быстрому пути (который сознательно
      // НЕ проверяет identity — см. спеку фикса и async-run.js). Проверить
      // именно кросс-процессный путь (единственный, где живёт identity-гейт)
      // можно только так же, как это уже делает bridge.test.js для
      // «pollRun synthesizes error/killed when observer died»: запись в
      // реестре есть, а activeRuns о ней ничего не знает.
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      pid = child.pid;
      child.unref();
      await sleep(50); // дать процессу реально стартовать

      const runId = 'manual-identity-run';
      await putRun(
        runId,
        {
          pid,
          pgid: pid,
          dshSessionId: null,
          state: 'running',
          startedAt: new Date().toISOString(),
          procStarttime: '999999999999', // заведомо чужое значение — как переиспользованный ОС номер
        },
        c.registryPath,
      );

      const res = await killRun(runId, { registryPath: c.registryPath, graceMs: 300 });

      assert.equal(isPidAlive(pid), true, 'процесс должен остаться жив: identity не совпала, сигнал не посылаем');
      assert.equal(res.killed, false, 'killRun не должен утверждать, что убил чужой процесс');
      assert.equal(res.state, 'error', 'запись всё равно финализируется — иначе висела бы running вечно');

      const after = await pollRun(runId, { registryPath: c.registryPath });
      assert.equal(after.state, 'error');
    } finally {
      // Настоящий процесс всё ещё жив (см. проверку выше) — это и есть суть
      // теста. envelope уже финализирован, поэтому повторный killRun по этому
      // runId — идемпотентный no-op и сигнала не пошлёт (быстрый возврат по
      // existingEnv в начале killRun). Убираем процесс НАПРЯМУЮ по известному в
      // тесте pid, в обход реестра — честная уборка, а не обход самой проверки.
      if (pid) killPgid(pid, 'SIGKILL') || killPid(pid, 'SIGKILL');
      await c.cleanup();
    }
  });

  it('запись без procStarttime (старый формат) убивается как раньше — обратная совместимость', async () => {
    const c = await ctx();
    const h = await c.run('__FAKE_HANG__');
    try {
      const reg = await readRegistry(c.registryPath);
      delete reg[h.runId].procStarttime;
      await writeRegistry(reg, c.registryPath);

      const res = await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
      assert.equal(res.killed, true, 'без procStarttime identity не проверяем — ведём себя как раньше');
      assert.equal(isPidAlive(h.pid), false, 'процесс должен быть мёртв');
    } finally {
      await c.cleanup();
    }
  });
});

// P1, дефект 3 (раунд 2 кросс-ревью): identity на ВСЕХ kill-путях, не только
// на первом сигнале кросс-процессного killRun.
describe('identity на всех kill-путях (раунд 2)', () => {
  it('v1 (runDsh) тоже пишет procStarttime в запись реестра (ловим поллингом во время рана)', async () => {
    const c = await ctx();
    const taskFile = join(c.dir, 'task-v1-procstarttime.txt');
    await writeFile(taskFile, '__FAKE_ENVELOPE_OK__ короткая задача', 'utf8');

    // v1 (runDsh) удаляет запись реестра сразу по завершении рана (см.
    // run.js), поэтому единственный способ увидеть procStarttime — поймать
    // запись поллингом, ПОКА ран ещё идёт (тот же приём, что и в
    // owner-watchdog.test.js для «синхронный путь (dsh_task)»).
    let seen = null;
    const poll = setInterval(async () => {
      if (seen) return;
      try {
        const reg = JSON.parse(await readFile(c.registryPath, 'utf8'));
        const entry = Object.values(reg)[0];
        if (entry) seen = entry;
      } catch {}
    }, 5);

    try {
      await runDsh({
        taskFile,
        cwd: c.dir,
        registryPath: c.registryPath,
        timeoutMs: 20000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      clearInterval(poll);
      assert.ok(seen, 'запись должна была появиться в реестре во время рана');
      assert.ok(
        typeof seen.procStarttime === 'string' && seen.procStarttime !== '',
        'v1 (runDsh) обязан писать procStarttime рядом с pid/pgid — иначе его kill-пути остаются без identity-проверки',
      );
    } finally {
      clearInterval(poll);
      await c.cleanup();
    }
  });

  it('эскалация SIGKILL перепроверяет identity: рассинхрон посреди grace — SIGKILL не шлём, живой процесс остаётся жив', async () => {
    const c = await ctx();
    let pid = null;
    try {
      // Кросс-процессный путь (как в тесте выше «подменённый procStarttime у
      // живого рана»): спавним НАПРЯМУЮ, в обход startDsh — иначе runId попал
      // бы в activeRuns, и killRun ушёл бы по локальному быстрому пути,
      // который сознательно НЕ перепроверяет identity при эскалации (свой
      // child, см. комментарий в async-run.js).
      //
      // SIGTERM игнорируем сами (аналог __FAKE_IGNORE_TERM__ из fake-dsh.js),
      // чтобы дойти до ветки эскалации SIGKILL, а не умереть от первого же
      // сигнала — ровно как раньше уже умел __FAKE_HANG__ до grace, только
      // тут ещё и SIGTERM не берёт вовсе.
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'], {
        detached: true,
        stdio: 'ignore',
      });
      pid = child.pid;
      child.unref();
      // Прогрев: дать интерпретатору реально дойти до process.on('SIGTERM',
      // ...) — без паузы первый SIGTERM в killRun может прилететь РАНЬШЕ
      // регистрации обработчика и убить процесс дефолтной диспозицией, не
      // проверив вообще ничего (тот же эффект уже ловили при отладке P0 п.2 —
      // см. отчёт задачи).
      await sleep(150);

      const runId = 'manual-escalation-run';
      await putRun(
        runId,
        {
          pid,
          pgid: pid,
          dshSessionId: null,
          state: 'running',
          startedAt: new Date().toISOString(),
          procStarttime: readProcStarttime(pid), // на момент захвата — точно НАШ процесс
        },
        c.registryPath,
      );

      // Гонка, которую в реальности вызвало бы переиспользование pid ОС между
      // первым SIGTERM и SIGKILL-эскалацией: подменяем procStarttime В
      // РЕЕСТРЕ ПОСРЕДИ grace-периода — то же наблюдаемое следствие
      // (перечитанная запись расходится с реальным /proc/<pid>/stat), просто
      // без настоящего убийства-и-переиспользования номера ОС, которое в
      // тесте детерминированно не воспроизвести.
      setTimeout(() => {
        updateRun(runId, { procStarttime: '999999999999' }, c.registryPath).catch(() => {});
      }, 100);

      const res = await killRun(runId, { registryPath: c.registryPath, graceMs: 400 });

      assert.equal(
        isPidAlive(pid),
        true,
        'подмена identity перед эскалацией должна была остановить SIGKILL — процесс обязан остаться жив',
      );
      assert.equal(res.state, 'error', 'запись всё равно финализируется — иначе висела бы running вечно');
    } finally {
      // Настоящий процесс всё ещё жив (см. проверку выше) — убираем напрямую
      // по известному в тесте pid, в обход реестра (честная уборка, как в
      // соседнем тесте выше про identity mismatch).
      if (pid) killPgid(pid, 'SIGKILL') || killPid(pid, 'SIGKILL');
      await c.cleanup();
    }
  });
});
