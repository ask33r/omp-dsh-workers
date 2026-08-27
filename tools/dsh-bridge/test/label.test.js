import './node-only.js';

// label — метка рана в startDsh(opts): опциональная строка, которая ложится в
// запись реестра и всплывает через listRuns. Нужна директору DVIBE, чтобы
// находить живой ран представителя в dsh_list по имени, заданному в брифе,
// без модельного реле (см. extensions/dsh-task/dvibe.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startDsh, killRun } from '../src/async-run.js';
import { getRun, listRuns } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

async function ctx() {
  const dir = await mkdtemp(join(tmpdir(), 'label-'));
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

describe('startDsh label', () => {
  it('сохраняется в записи реестра и виден через listRuns', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__', { label: 'worker-a' });
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label, 'worker-a');

      const all = await listRuns(c.registryPath);
      assert.equal(all[h.runId]?.label, 'worker-a');

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('без label — label: null', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__');
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label, null);

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('обрезает пробелы по краям: "  x  " -> "x"', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__', { label: '  x  ' });
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label, 'x');

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('пустая строка — как отсутствие label (null)', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__', { label: '' });
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label, null);

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('только пробелы — как отсутствие label (null)', async () => {
    const c = await ctx();
    try {
      const h = await c.run('__FAKE_HANG__', { label: '   ' });
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label, null);

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });

  it('длиннее 80 символов — обрезано ровно до 80', async () => {
    const c = await ctx();
    try {
      const long = 'L'.repeat(90);
      const h = await c.run('__FAKE_HANG__', { label: long });
      const entry = await getRun(h.runId, c.registryPath);
      assert.equal(entry.label.length, 80);
      assert.equal(entry.label, long.slice(0, 80));

      await killRun(h.runId, { registryPath: c.registryPath, graceMs: 300 });
    } finally {
      await c.cleanup();
    }
  });
});
