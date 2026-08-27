import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startDsh, killRun, ownRunIds } from '../src/index.js';
import { putRun } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunSettled } from './wait-helpers.js';

const FIXTURES_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

async function makeTestDir() {
  const testDir = await mkdtemp(join(tmpdir(), 'own-runs-'));
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

describe('ownRunIds (процесс-локальные раны для session_shutdown)', () => {
  it('после startDsh ownRunIds содержит runId, после завершения — не содержит', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_ENVELOPE_OK__ own-runs-quick');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      let ids = ownRunIds();
      assert.ok(ids.includes(handle.runId), 'ownRunIds должен содержать только что стартовавший ран');

      // Дождаться завершения рана — после этого ownRunIds не должен его содержать
      await waitRunSettled(handle.runId, { waitMs: 3000, registryPath });
      ids = ownRunIds();
      assert.ok(!ids.includes(handle.runId), 'после завершения рана он уходит из ownRunIds');
    } finally {
      await cleanup(testDir);
    }
  });

  it('после killRun ownRunIds не содержит убитый ран', async () => {
    const { testDir, registryPath, cwd } = await makeTestDir();
    try {
      const taskFile = await writeTask(testDir, '__FAKE_HANG__ own-runs-kill');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FIXTURES_DSH },
      });

      assert.ok(ownRunIds().includes(handle.runId));
      await killRun(handle.runId, { registryPath, graceMs: 500 });
      assert.ok(!ownRunIds().includes(handle.runId), 'после killRun ран уходит из ownRunIds');
    } finally {
      await cleanup(testDir);
    }
  });

  it('ран, записанный только в реестр через putRun (чужой процесс), не попадает в ownRunIds', async () => {
    const { testDir, registryPath } = await makeTestDir();
    try {
      // Чужой ран — только реестр, без activeRuns в этом процессе
      const foreignRunId = `foreign-${Date.now()}`;
      await putRun(
        foreignRunId,
        {
          pid: 999999,
          pgid: 999999,
          dshSessionId: null,
          state: 'running',
          startedAt: new Date().toISOString(),
          cwd: testDir,
          logFile: join(testDir, 'var', 'runs', `${foreignRunId}.log`),
          envelopeFile: join(testDir, 'var', 'runs', `${foreignRunId}.envelope.json`),
          steerFile: join(testDir, 'var', 'runs', `${foreignRunId}.steer.jsonl`),
          exitCode: null,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          leaseUntil: new Date(Date.now() + 60000).toISOString(),
          label: 'foreign',
        },
        registryPath,
      );
      assert.ok(!ownRunIds().includes(foreignRunId), 'чужой реестровый ран не должен попадать в ownRunIds');
    } finally {
      await cleanup(testDir);
    }
  });
});
