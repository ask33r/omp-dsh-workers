import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { killTestProcess } from './kill-safe.js';
import { isPidAlive } from '../src/registry.js';

/**
 * Регрессия на инцидент «bare `bun test` убивает контейнер».
 *
 * Прямой `process.kill(-pgid, 'SIGKILL')` в cleanup-коде тестов безопасен ровно
 * до тех пор, пока pgid настоящий. Когда `mock.module()` из bun-тестов
 * extensions протекает в node-тесты моста (mock.module в bun ГЛОБАЛЬНЫЙ на
 * процесс и не откатывается между файлами), `startDsh` возвращает фикстуру с
 * `pid: 1, pgid: 1` — и `process.kill(-1, SIGKILL)` в POSIX это не «группа 1»,
 * а BROADCAST всем процессам пользователя: в контейнере он сносит PID 1-обвязку
 * и убивает всю сессию.
 *
 * Поэтому cleanup обязан ходить через killTestProcess, который переиспользует
 * те же гарды isSafePgid/isSafePid, что и продовый killPgid/killPid.
 */
describe('killTestProcess: гарды против broadcast-kill из тестового cleanup', () => {
  // Заведомо несуществующий номер: больше любого /proc/sys/kernel/pid_max,
  // поэтому он не может совпасть с pgid самого тестового процесса (isSafePgid
  // отвергает собственную группу — на «обычном» числе тест иногда флакал бы).
  const FAKE = 2_000_000_001;

  /**
   * Шпион вместо process.kill: реальный сигнал в этих кейсах слать нельзя —
   * именно его отсутствие мы и проверяем. stderr тоже перехватываем, чтобы
   * предупреждения хелпера не засоряли вывод node --test и были проверяемы.
   */
  function withKillSpy(fn, { killImpl } = {}) {
    const originalKill = process.kill;
    const originalWrite = process.stderr.write;
    const calls = [];
    const stderr = [];
    process.kill = (target, signal) => {
      calls.push({ target, signal });
      if (killImpl) return killImpl(target, signal);
      return true;
    };
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      return fn({ calls, stderr });
    } finally {
      process.kill = originalKill;
      process.stderr.write = originalWrite;
    }
  }

  it('утёкший мок (pid=1, pgid=1) не приводит НИ К ОДНОМУ сигналу', () => {
    withKillSpy(({ calls, stderr }) => {
      const sent = killTestProcess(1, 1, 'SIGKILL');
      assert.equal(sent, false, 'ничего не отправлено');
      assert.deepEqual(calls, [], 'process.kill не должен вызываться вообще — это и есть kill(-1) broadcast');
      assert.ok(stderr.join('').includes('kill-safe'), 'небезопасное значение обязано быть заметно в stderr');
    });
  });

  it('прочие небезопасные значения pgid тоже отсекаются', () => {
    for (const pgid of [1, 0, -1, -5, undefined, null, NaN, 1.5, '123']) {
      withKillSpy(({ calls }) => {
        killTestProcess(undefined, pgid, 'SIGKILL');
        assert.deepEqual(calls, [], `pgid=${String(pgid)} не должен породить сигнал`);
      });
    }
  });

  it('прочие небезопасные значения pid тоже отсекаются', () => {
    for (const pid of [1, 0, -1, undefined, null, NaN, 1.5, '123']) {
      withKillSpy(({ calls }) => {
        killTestProcess(pid, undefined, 'SIGKILL');
        assert.deepEqual(calls, [], `pid=${String(pid)} не должен породить сигнал`);
      });
    }
  });

  it('собственный pid никогда не получает сигнал (тест не должен убивать себя)', () => {
    withKillSpy(({ calls }) => {
      killTestProcess(process.pid, undefined, 'SIGKILL');
      assert.deepEqual(calls, []);
    });
  });

  it('нормальные значения: сигнал уходит и в группу, и в pid', () => {
    withKillSpy(({ calls, stderr }) => {
      const sent = killTestProcess(FAKE, FAKE, 'SIGKILL');
      assert.equal(sent, true);
      assert.deepEqual(calls, [
        { target: -FAKE, signal: 'SIGKILL' },
        { target: FAKE, signal: 'SIGKILL' },
      ]);
      assert.equal(stderr.join(''), '', 'на безопасных значениях предупреждать не о чем');
    });
  });

  it('сигнал по умолчанию — SIGKILL (cleanup обязан добивать)', () => {
    withKillSpy(({ calls }) => {
      killTestProcess(FAKE, undefined);
      assert.deepEqual(calls, [{ target: FAKE, signal: 'SIGKILL' }]);
    });
  });

  it('ESRCH проглатывается молча: процесс уже умер — это норма для cleanup', () => {
    withKillSpy(
      ({ stderr }) => {
        const sent = killTestProcess(FAKE, FAKE, 'SIGKILL');
        assert.equal(sent, false, 'ничего живого не задето');
        assert.equal(stderr.join(''), '', 'ESRCH не повод шуметь');
      },
      {
        killImpl: () => {
          const err = new Error('kill ESRCH');
          err.code = 'ESRCH';
          throw err;
        },
      },
    );
  });

  it('прочие ошибки не бросаются наружу (иначе finally затрёт настоящий провал теста)', () => {
    withKillSpy(
      ({ stderr }) => {
        assert.doesNotThrow(() => killTestProcess(FAKE, FAKE, 'SIGKILL'));
        assert.ok(stderr.join('').includes('EPERM'), 'но видны в stderr');
      },
      {
        killImpl: () => {
          const err = new Error('kill EPERM');
          err.code = 'EPERM';
          throw err;
        },
      },
    );
  });

  it('интеграция: настоящий detached-процесс действительно умирает', async () => {
    const child = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    child.unref();
    try {
      assert.equal(isPidAlive(pid), true, 'sanity: фикстура запустилась');
      assert.equal(killTestProcess(pid, pid, 'SIGKILL'), true);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(isPidAlive(pid), false, 'после killTestProcess процесса быть не должно');
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  });
});
