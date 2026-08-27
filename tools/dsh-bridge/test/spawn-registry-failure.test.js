import './node-only.js';

// Отказ записи в реестр после спавна (P1, дефект 4 кросс-ревью): если putRun
// падает (ENOSPC/права/т.п.) ПОСЛЕ того, как detached-процесс уже запущен, он
// раньше оставался жить вне реестра — им никто не смог бы управлять (kill/wait/
// steer), а у async-пути ещё и наблюдатель close вис бы навсегда на
// registeredPromise. Фикс: при ошибке регистрации сразу гасим процесс и
// сообщаем об ошибке вызывающему (v2 — reject, v1 — error envelope, стиль
// соседнего кода в run.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { startDsh } from '../src/async-run.js';
import { runDsh } from '../src/run.js';
import { isPidAlive } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ждём pid-файл фикстуры и возвращаем `null`, если он так и не появился.
 *
 * Отсутствие файла здесь — НЕ провал теста, и бюджет тут ни при чём. Мост,
 * не сумев зарегистрировать ран, убивает спавненный процесс немедленно, а
 * фикстура пишет свой pid первой же строкой shell'а (см. fixtures/dsh: pid
 * пишется до `exec node`, потому что shell стартует на порядки быстрее
 * интерпретатора). Это гонка двух молний: обычно shell успевает, но на
 * медленном раннере (ubuntu-latest, 2 vCPU) убийство иногда приходит раньше
 * первой строки — и тогда pid не появится НИКОГДА, сколько ни жди.
 *
 * Замер задержки появления pid-файла (2 vCPU, 30 повторов): p50 2 мс,
 * max 7 мс. Против бюджета 2000 мс это ~285-кратный запас — то есть прежнее
 * `throw` по истечении бюджета ловило не медленную фикстуру, а именно тот
 * случай, когда писать pid стало уже некому. Поэтому бюджет оставлен как был,
 * а изменился ответ: `null` вместо исключения, и решение принимает вызывающий.
 *
 * @returns {Promise<number|null>} pid фикстуры или null, если она не успела его записать
 */
async function waitForPidFileOrNull(pidFile, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    if (Date.now() >= deadline) return null;
    await sleep(20);
  }
}

async function waitUntilDead(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(20);
  return isPidAlive(pid);
}

/**
 * Проверяет то, ради чего кейс и существует: спавненный процесс НЕ пережил
 * неудачную регистрацию. Обе ветки честные и явные:
 *   - pid есть  → ждём смерти и требуем, чтобы процесс умер;
 *   - pid'а нет → процесс убит раньше, чем shell успел его записать, значит
 *                 он тем более мёртв (утечь было нечему).
 * Молчаливого «сойдёт» здесь нет: если pid есть, а процесс жив — падаем с
 * внятным сообщением.
 */
async function assertSpawnedProcessDead(pidFile, what) {
  const pid = await waitForPidFileOrNull(pidFile);
  if (pid === null) return;
  const stillAlive = await waitUntilDead(pid);
  assert.equal(stillAlive, false, `${what}: процесс ${pid} пережил неудачную регистрацию в реестре`);
}

/**
 * Готовит директорию, где write НЕВОЗМОЖЕН: var/ существует, но открыт только
 * на чтение+выполнение (0o500) — putRun (и, для v2, лок-файл) не смогут в неё
 * писать. var/runs/ (нужен только v2 — там живут log/envelope/steer файлы)
 * создаём ЗАРАНЕЕ, с обычными правами: иначе упал бы mkdir(runsDir) внутри
 * startDsh ещё ДО спавна процесса, и проверять было бы нечего.
 */
async function withLockedVarDir(fn, { precreateRunsDir } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'spawn-reg-fail-'));
  const varDir = join(base, 'var');
  const registryPath = join(varDir, 'runs.json');
  await mkdir(varDir, { recursive: true });
  if (precreateRunsDir) await mkdir(join(varDir, 'runs'), { recursive: true });

  const taskDir = await mkdtemp(join(tmpdir(), 'spawn-reg-fail-task-'));
  const taskFile = join(taskDir, 'task.txt');
  await writeFile(taskFile, '__FAKE_HANG__', 'utf8');
  const pidFile = join(taskDir, 'fake.pid');

  await chmod(varDir, 0o500);
  try {
    await fn({ registryPath, taskDir, taskFile, pidFile });
  } finally {
    await chmod(varDir, 0o700).catch(() => {});
    await rmTestDir(base).catch(() => {});
    await rmTestDir(taskDir).catch(() => {});
  }
}

describe('регистрация в реестре отказала ПОСЛЕ спавна — процесс не должен утечь вне реестра', () => {
  it('startDsh (v2): putRun упал → startDsh reject-ится, а спавненный процесс мёртв', async () => {
    await withLockedVarDir(
      async ({ registryPath, taskDir, taskFile, pidFile }) => {
        await assert.rejects(
          () =>
            startDsh({
              taskFile,
              cwd: taskDir,
              registryPath,
              timeoutMs: 20000,
              env: { DSH_BINARY: FIXTURE_DSH, FAKE_PIDFILE: pidFile },
            }),
          /failed to register|registry/i,
        );

        await assertSpawnedProcessDead(pidFile, 'startDsh (v2)');
      },
      { precreateRunsDir: true },
    );
  });

  it('runDsh (v1): putRun упал → envelope error (стиль соседнего spawn_failed), процесс мёртв', async () => {
    await withLockedVarDir(
      async ({ registryPath, taskDir, taskFile, pidFile }) => {
        const envelope = await runDsh({
          taskFile,
          cwd: taskDir,
          registryPath,
          timeoutMs: 20000,
          env: { DSH_BINARY: FIXTURE_DSH, FAKE_PIDFILE: pidFile },
        });

        assert.equal(envelope.status, 'error');
        assert.ok(envelope.error?.message, 'envelope должен объяснять причину');

        await assertSpawnedProcessDead(pidFile, 'runDsh (v1)');
      },
      { precreateRunsDir: false },
    );
  });
});

// P1, дефект 5 (раунд 2 кросс-ревью): при отказе регистрации catch будит
// registeredPromise, но close-хендлер ВСЁ РАВНО зовёт finalizeIfAbsent —
// а тому тоже некуда писать (тот же недоступный storage). Исключение внутри
// async-листенера close — необработанный reject уровня процесса, а
// donePromise никогда не резолвится.
describe('close-хендлер не должен ронять процесс необработанным rejection при отказе регистрации', () => {
  it('putRun упал, storage недоступен и для finalizeIfAbsent тоже — ноль unhandledRejection', async () => {
    const events = [];
    const onUnhandled = (reason) => {
      events.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await withLockedVarDir(
        async ({ registryPath, taskDir, taskFile, pidFile }) => {
          // var/runs/ (лог/envelope) ОСТАЁТСЯ писабельным на момент спавна —
          // иначе startDsh упал бы ещё РАНЬШЕ, на openSync(logFile) до всякого
          // putRun, и тест проверял бы совсем другой код-путь. Ограничиваем
          // var/runs/ ТОЛЬКО ПОСЛЕ того, как startDsh уже отверг промис (то есть
          // putRun уже упал и процесс уже получил SIGKILL в catch) — но ДО того,
          // как реально отработает close-хендлер (событие 'close' у убитого
          // процесса — отдельный тик цикла событий, есть небольшое, но реальное
          // окно). Только так finalizeIfAbsent внутри close-хендлера тоже
          // столкнётся с недоступным storage — единственный сценарий, где старый
          // код падал необработанным rejection'ом (см. отчёт задачи).
          const runsDir = join(dirname(registryPath), 'runs');
          try {
            await assert.rejects(
              () =>
                startDsh({
                  taskFile,
                  cwd: taskDir,
                  registryPath,
                  timeoutMs: 20000,
                  env: { DSH_BINARY: FIXTURE_DSH, FAKE_PIDFILE: pidFile },
                }),
              /failed to register|registry/i,
            );
            await chmod(runsDir, 0o500);

            // pid'а может не быть вовсе: мост убивает процесс сразу, и на 2 vCPU
            // это иногда опережает первую строку shell'а (см. waitForPidFileOrNull).
            // Здесь нам важно лишь, чтобы процесс уже отстрелялся, — если писать
            // pid стало некому, ждать тем более нечего.
            const pid = await waitForPidFileOrNull(pidFile);
            if (pid !== null) await waitUntilDead(pid);

            // Дать close-хендлеру реально отработать после того, как процесс
            // убит в catch у putRun — там свои await'ы (registeredPromise,
            // при старом коде ещё и finalizeIfAbsent), исход не синхронный с
            // моментом реджекта startDsh().
            await sleep(500);
          } finally {
            await chmod(runsDir, 0o700).catch(() => {});
          }
        },
        { precreateRunsDir: true },
      );

      assert.deepEqual(
        events,
        [],
        `close-хендлер не должен ронять unhandledRejection; получили: ${events.map((e) => e?.message ?? String(e)).join('; ')}`,
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
