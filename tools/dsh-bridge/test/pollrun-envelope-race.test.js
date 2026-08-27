import './node-only.js';

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pollRun, startDsh } from '../src/async-run.js';
import { putRun } from '../src/registry.js';
import { deadPid, linkEnvelopeIfAbsent, makeRaceCtx, sleep } from './race-helpers.js';
import { rmTestDir } from './tmp-cleanup.js';
import { describeRun } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

const makeCtx = () => makeRaceCtx('pollrun-envelope-');

describe('pollRun: envelope дописывается ПОСЛЕ смерти pid', () => {
  // Гонка (баг раунда 2, класс E): pollRun видит «pid мёртв + envelope-файла
  // нет» и по инварианту 3 синтезирует error/killed, закрепляя его через
  // finalizeIfAbsent (link => кто первый, тот и прав). Настоящий envelope,
  // который наблюдатель дописывает мгновением позже, получает EEXIST и
  // отбрасывается — успешно завершённый ран НАВСЕГДА остаётся убитым.
  //
  // Кейс детерминированный: pid заведомо мёртв ДО вызова, envelope появляется
  // через фиксированные 300 мс. До фикса pollRun отвечает синтетикой мгновенно
  // (в тот момент envelope ещё физически нет), после фикса — ждёт в пределах
  // общего с killRun бюджета и отдаёт настоящий результат.
  it('cross-process: отдаёт настоящий completed, а не синтетический killed', async () => {
    const ctx = await makeCtx();
    try {
      const runId = randomUUID();
      const pid = await deadPid();
      const envelopeFile = join(ctx.runsDir, `${runId}.envelope.json`);

      await putRun(
        runId,
        {
          pid,
          pgid: pid,
          dshSessionId: 'session-cross-process',
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

      const real = {
        v: 1,
        runId,
        sessionId: 'session-cross-process',
        status: 'completed',
        result: 'настоящий результат рана',
      };
      // «Наблюдатель чужого процесса» дописывает envelope с задержкой.
      const writer = sleep(300).then(() => linkEnvelopeIfAbsent(envelopeFile, real));

      const r = await pollRun(runId, { registryPath: ctx.registryPath });
      await writer;

      assert.equal(r.state, 'completed', `pollRun отдал не тот результат: ${describeRun(r)}`);
      assert.equal(r.envelope.status, 'completed');
      assert.equal(r.envelope.result, 'настоящий результат рана');

      // И на диске должен остаться настоящий envelope: если pollRun закрепил
      // синтетику, результат рана потерян навсегда — это и есть ущерб от бага.
      const onDisk = JSON.parse(await readFile(envelopeFile, 'utf8'));
      assert.equal(onDisk.status, 'completed', `на диске закрепился не тот envelope: ${JSON.stringify(onDisk)}`);
      assert.equal(onDisk.result, 'настоящий результат рана');
    } finally {
      await rmTestDir(ctx.dir);
    }
  });

  // Тот же инвариант, но для рана ЭТОГО процесса: у моста есть donePromise, и
  // окно «close уже случился, finalizeIfAbsent ещё пишет» узкое. Ловим его
  // плотным опросом без пауз — так пробы попадают в окно многократно.
  // После фикса синтетический killed не должен появиться НИ РАЗУ: это
  // регрессионный сторож, который может покраснеть только если баг вернулся.
  it('in-process: плотный опрос быстрого рана ни разу не даёт синтетический killed', async () => {
    const ctx = await makeCtx();
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

        // Без sleep: опрашиваем вплотную, чтобы попасть в окно между смертью
        // процесса и записью envelope.
        let r;
        for (;;) {
          r = await pollRun(handle.runId, { registryPath: ctx.registryPath });
          if (r.state !== 'running') break;
        }
        if (r.state !== 'completed') bad.push(`итерация ${i}: ${describeRun(r)}`);
      }
      assert.deepEqual(bad, [], `ран завершился успешно, но pollRun отдал синтетику:\n${bad.join('\n')}`);
    } finally {
      await rmTestDir(ctx.dir);
    }
  });
});
