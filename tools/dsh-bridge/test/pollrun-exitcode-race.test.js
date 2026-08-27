import './node-only.js';

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pollRun, startDsh, waitRun } from '../src/async-run.js';
import { putRun, updateRun } from '../src/registry.js';
import { deadPid, linkEnvelopeIfAbsent, makeRaceCtx, sleep } from './race-helpers.js';
import { rmTestDir } from './tmp-cleanup.js';
import { describeRun } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

/**
 * Ставит ран ровно в то состояние, в котором его застаёт баг: envelope уже
 * закреплён на диске, а реестровая запись всё ещё `running`/`exitCode: null`.
 *
 * Это НЕ искусственная поза: finalizeIfAbsent обязан обновлять реестр ПОСЛЕ
 * link() (реестр отражает envelope, победивший в гонке), поэтому окно между
 * ними существует у каждого нормально завершившегося рана. Здесь оно просто
 * растянуто до фиксированных `updateDelayMs` — «медленный финализатор чужого
 * процесса», — чтобы кейс не зависел от скорости диска тестовой машины.
 */
async function stageInFlightFinalization(ctx, { linkDelayMs = 0, updateDelayMs = 300 } = {}) {
  const runId = randomUUID();
  const pid = await deadPid();
  const envelopeFile = join(ctx.runsDir, `${runId}.envelope.json`);

  await putRun(
    runId,
    {
      pid,
      pgid: pid,
      dshSessionId: 'session-exitcode-race',
      state: 'running',
      startedAt: new Date().toISOString(),
      cwd: ctx.dir,
      logFile: join(ctx.runsDir, `${runId}.log`),
      envelopeFile,
      steerFile: join(ctx.runsDir, `${runId}.steer.jsonl`),
      exitCode: null,
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
      label: null,
      procStarttime: null,
    },
    ctx.registryPath,
  );

  const writeEnvelope = () =>
    linkEnvelopeIfAbsent(envelopeFile, {
      v: 1,
      runId,
      sessionId: 'session-exitcode-race',
      status: 'completed',
      result: 'настоящий результат рана',
    });
  const commitRegistry = () => updateRun(runId, { state: 'completed', exitCode: 0 }, ctx.registryPath);

  // linkDelayMs = 0 — envelope уже на диске к моменту вызова, и pollRun входит
  // в ВЕРХНИЙ путь (`existing`). linkDelayMs > 0 — файл появляется уже во время
  // вызова, и pollRun входит во второй путь, через waitForEnvelopeFile: тот
  // возвращает envelope в момент его появления, то есть ровно внутри окна. Оба
  // пути превращают envelope в результат и обязаны ждать реестр одинаково.
  if (linkDelayMs === 0) await writeEnvelope();
  const finalizer = (linkDelayMs === 0 ? Promise.resolve() : sleep(linkDelayMs).then(writeEnvelope))
    .then(() => sleep(updateDelayMs))
    .then(commitRegistry);

  return { runId, finalizer };
}

describe('pollRun: реестр догоняет envelope (exitCode не null)', () => {
  // Гонка, вскрытая CI (run 33076874174, 2 vCPU): в finalizeIfAbsent порядок
  // событий — link(envelope) → updateRun(state, exitCode). Между ними файл уже
  // виден всем, а реестр ещё стоит в `running`/`exitCode: null`. pollRun,
  // попавший в это окно, видит envelope, читает реестр и отдаёт
  // `completed` + `exitCode: null` — итог зафиксирован НЕВЕРНО, и waitRun на
  // нём завершается (state ≠ running), второго шанса нет.
  //
  // Верное прочтение: «envelope есть, а запись ещё running» — это финализация
  // В ПОЛЁТЕ, а не итог. Ждать её надо тем же ограниченным бюджетом, каким
  // инвариант 3 ждёт сам envelope.
  it('cross-process: pollRun ждёт реестр и отдаёт exitCode 0, а не null', async () => {
    const ctx = await makeRaceCtx('pollrun-exitcode-');
    try {
      const { runId, finalizer } = await stageInFlightFinalization(ctx);

      const r = await pollRun(runId, { registryPath: ctx.registryPath });
      await finalizer;

      assert.equal(r.state, 'completed', `pollRun отдал не тот результат: ${describeRun(r)}`);
      assert.equal(r.envelope.result, 'настоящий результат рана');
      assert.equal(r.exitCode, 0, `pollRun зафиксировал итог до обновления реестра: ${describeRun(r)}`);
    } finally {
      await rmTestDir(ctx.dir);
    }
  });

  // Тот же ран, но глазами владельца: waitRun выходит по первому же
  // терминальному состоянию от pollRun, поэтому неверный exitCode здесь
  // становится ОКОНЧАТЕЛЬНЫМ ответом директору — ровно так падал кейс 4
  // async-run.test.js в CI (expected: 0, actual: null).
  it('cross-process: waitRun возвращает exitCode 0, а не null', async () => {
    const ctx = await makeRaceCtx('waitrun-exitcode-');
    try {
      const { runId, finalizer } = await stageInFlightFinalization(ctx);

      const r = await waitRun(runId, { waitMs: 3000, registryPath: ctx.registryPath });
      await finalizer;

      assert.equal(r.state, 'completed', `waitRun отдал не тот результат: ${describeRun(r)}`);
      assert.equal(r.exitCode, 0, `waitRun зафиксировал итог до обновления реестра: ${describeRun(r)}`);
    } finally {
      await rmTestDir(ctx.dir);
    }
  });

  // Второй путь того же превращения: envelope-файла в момент вызова ещё нет,
  // и pollRun доходит до waitForEnvelopeFile. Тот возвращает файл В МОМЕНТ его
  // появления — то есть гарантированно внутри окна link→updateRun, ещё вернее,
  // чем верхний путь. Оба места обязаны ходить через один хелпер; фикс только
  // на верхнем пути оставил бы гонку ровно там, где она вероятнее всего.
  it('cross-process: envelope, пойманный ожиданием файла, тоже ждёт реестр', async () => {
    const ctx = await makeRaceCtx('waitfile-exitcode-');
    try {
      const { runId, finalizer } = await stageInFlightFinalization(ctx, {
        linkDelayMs: 200,
        updateDelayMs: 300,
      });

      const r = await pollRun(runId, { registryPath: ctx.registryPath });
      await finalizer;

      assert.equal(r.state, 'completed', `pollRun отдал не тот результат: ${describeRun(r)}`);
      assert.equal(r.exitCode, 0, `путь waitForEnvelopeFile отдал итог до обновления реестра: ${describeRun(r)}`);
    } finally {
      await rmTestDir(ctx.dir);
    }
  });

  // Регрессионный сторож для ранов ЭТОГО процесса: окно link→updateRun здесь
  // измеряется миллисекундами, поймать его sleep'ом нельзя — ловим плотным
  // опросом без пауз, так пробы попадают в окно многократно. Fixture dsh
  // выходит с 0, поэтому `exitCode: null` у завершившегося рана может означать
  // только возврат бага.
  it('in-process: плотный опрос быстрых ранов ни разу не даёт exitCode null', async () => {
    const ctx = await makeRaceCtx('pollrun-exitcode-local-');
    try {
      const ITERATIONS = 25;
      const bad = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const taskFile = join(ctx.dir, `task-${i}.txt`);
        await writeFile(taskFile, '__FAKE_ENVELOPE_OK__ быстрый ран', 'utf8');
        const handle = await startDsh({
          taskFile,
          cwd: ctx.dir,
          registryPath: ctx.registryPath,
          timeoutMs: 20000,
          env: { DSH_BINARY: FIXTURE_DSH },
        });

        let r;
        for (;;) {
          r = await pollRun(handle.runId, { registryPath: ctx.registryPath });
          if (r.state !== 'running') break;
        }
        if (r.state !== 'completed' || r.exitCode !== 0) bad.push(`итерация ${i}: ${describeRun(r)}`);
      }
      assert.deepEqual(bad, [], `ран завершился с кодом 0, но pollRun отдал другое:\n${bad.join('\n')}`);
    } finally {
      await rmTestDir(ctx.dir);
    }
  });
});
