// DSH_WORKER_PATCH: оба раннера обязаны подставить --patch <path> в argv dsh,
// чтобы headless-воркеры моста стартовали с lean-оверлеем (persona + минимум
// плагинов). fake-dsh пишет diagnostics в FAKE_DSH_LOG с rawArgs — читаем его.
import './node-only.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDsh, killRun } from '../src/index.js';
import { runDsh } from '../src/run.js';
import { rmTestDir } from './tmp-cleanup.js';

const FAKE_DSH = resolve(join(import.meta.dirname, 'fake-dsh.js'));

async function makeDir() {
  const testDir = await mkdtemp(join(tmpdir(), 'worker-patch-'));
  const registryPath = join(testDir, 'var', 'runs.json');
  return { testDir, registryPath, cwd: testDir };
}

describe('DSH_WORKER_PATCH lean overlay flag', () => {
  it('startDsh (async) appends --patch <path> when DSH_WORKER_PATCH is set', async () => {
    const { testDir, registryPath, cwd } = await makeDir();
    const logFile = join(testDir, 'fake.log');
    try {
      const taskFile = join(testDir, 'task.txt');
      await writeFile(taskFile, '__FAKE_HANG__ lean-flag', 'utf8');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: {
          DSH_BINARY: FAKE_DSH,
          FAKE_DSH_LOG: logFile,
          DSH_WORKER_PATCH: '/home/asker/.dsh/overlays/worker-lean.yml',
        },
      });
      // fake-dsh пишет argv-диагностику сразу при старте; Hang-маркер держит процесс живым.
      let rawArgs = null;
      for (let i = 0; i < 40 && !rawArgs; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
          const info = JSON.parse(lines[lines.length - 1]);
          if (info.argv) rawArgs = info.argv;
        } catch {}
      }
      assert.ok(rawArgs, 'fake-dsh diagnostics log written');
      const patchIdx = rawArgs.indexOf('--patch');
      assert.ok(patchIdx !== -1, '--patch present in argv');
      assert.equal(rawArgs[patchIdx + 1], '/home/asker/.dsh/overlays/worker-lean.yml');
      assert.ok(rawArgs.includes('--profile') && rawArgs[rawArgs.indexOf('--profile') + 1] === 'headless');
      await killRun(handle.runId, { registryPath, graceMs: 500 }).catch(() => {});
    } finally {
      await rmTestDir(testDir).catch(() => {});
    }
  });

  it('startDsh omits --patch when DSH_WORKER_PATCH is unset', async () => {
    const { testDir, registryPath, cwd } = await makeDir();
    const logFile = join(testDir, 'fake.log');
    try {
      const taskFile = join(testDir, 'task.txt');
      await writeFile(taskFile, '__FAKE_HANG__ no-flag', 'utf8');
      const handle = await startDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 8000,
        env: { DSH_BINARY: FAKE_DSH, FAKE_DSH_LOG: logFile },
      });
      let rawArgs = null;
      for (let i = 0; i < 40 && !rawArgs; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
          const info = JSON.parse(lines[lines.length - 1]);
          if (info.argv) rawArgs = info.argv;
        } catch {}
      }
      assert.ok(rawArgs, 'fake-dsh diagnostics log written');
      assert.equal(rawArgs.indexOf('--patch'), -1);
      await killRun(handle.runId, { registryPath, graceMs: 500 }).catch(() => {});
    } finally {
      await rmTestDir(testDir).catch(() => {});
    }
  });

  it('runDsh (sync) appends --patch when DSH_WORKER_PATCH is set', async () => {
    const { testDir, registryPath, cwd } = await makeDir();
    const logFile = join(testDir, 'fake.log');
    try {
      const taskFile = join(testDir, 'task.txt');
      await writeFile(taskFile, 'echo-only sync-lean-flag', 'utf8');
      const envelope = await runDsh({
        taskFile,
        cwd,
        registryPath,
        timeoutMs: 15000,
        env: {
          DSH_BINARY: FAKE_DSH,
          FAKE_DSH_LOG: logFile,
          DSH_WORKER_PATCH: '/home/asker/.dsh/overlays/worker-lean.yml',
        },
      });
      assert.ok(envelope, 'envelope present');
      const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
      const info = JSON.parse(lines[lines.length - 1]);
      const patchIdx = info.argv.indexOf('--patch');
      assert.ok(patchIdx !== -1, '--patch present in argv');
      assert.equal(info.argv[patchIdx + 1], '/home/asker/.dsh/overlays/worker-lean.yml');
    } finally {
      await rmTestDir(testDir).catch(() => {});
    }
  });
});
