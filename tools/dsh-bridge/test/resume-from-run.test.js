import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startDsh, killRun, sessionIdOfRun } from '../src/async-run.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunInState } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

async function ctx() {
  const dir = await mkdtemp(join(tmpdir(), 'resume-from-'));
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

describe('sessionIdOfRun', () => {
  it('достаёт sessionId завершённого рана по его runId', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_ENVELOPE_OK__ задача');
      await waitRunInState(h.runId, 'completed', { waitMs: 10000, registryPath: c.registryPath });
      const sid = await sessionIdOfRun(h.runId, c.registryPath);
      assert.match(sid, /^session-/, 'вернулся идентификатор сессии DSH, а не рана');
      assert.notEqual(sid, h.runId, 'runId и sessionId — разные вещи');
    } finally {
      await c.cleanup();
    }
  });

  it('незавершённый ран сессии ещё не имеет', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__');
      assert.equal(await sessionIdOfRun(h.runId, c.registryPath), null);
      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('неизвестный ран — null, а не исключение', async () => {
    const c = await ctx();
    try {
      assert.equal(await sessionIdOfRun('нет-такого', c.registryPath), null);
    } finally {
      await c.cleanup();
    }
  });
});

describe('startDsh resumeFromRunId', () => {
  it('продолжает сессию предыдущего рана, взяв её sessionId сам', async () => {
    const c = await ctx();
    try {
      const first = await c.run('__FAKE_ENVELOPE_OK__ первый ход');
      const done = await waitRunInState(first.runId, 'completed', { waitMs: 10000, registryPath: c.registryPath });
      const sid = done.envelope.sessionId;
      assert.ok(sid);

      const second = await c.run('__FAKE_ENVELOPE_OK__ второй ход', { resumeFromRunId: first.runId });
      const done2 = await waitRunInState(second.runId, 'completed', { waitMs: 10000, registryPath: c.registryPath });
      // Фикстура возвращает как sessionId то, что пришло в --resume.
      assert.equal(done2.envelope.sessionId, sid, 'второй ход продолжил ту же сессию');
    } finally {
      await c.cleanup();
    }
  });

  it('явный resumeSessionId сильнее: он адресует сессию напрямую', async () => {
    const c = await ctx();
    try {
      const first = await c.run('__FAKE_ENVELOPE_OK__ ход');
      await waitRunInState(first.runId, 'completed', { waitMs: 10000, registryPath: c.registryPath });

      const second = await c.run('__FAKE_ENVELOPE_OK__ ход', {
        resumeFromRunId: first.runId,
        resumeSessionId: 'session-explicit-42',
      });
      const done = await waitRunInState(second.runId, 'completed', { waitMs: 10000, registryPath: c.registryPath });
      assert.equal(done.envelope.sessionId, 'session-explicit-42');
    } finally {
      await c.cleanup();
    }
  });

  it('ран без сессии — явная ошибка, а не тихий старт с нуля', async () => {
    const c = await ctx();
    try {
      await assert.rejects(() => c.run('задача', { resumeFromRunId: 'нет-такого-рана' }), /no session/i);
    } finally {
      await c.cleanup();
    }
  });
});
