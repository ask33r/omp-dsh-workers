import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { runDsh } from '../src/run.js';
import { startDsh } from '../src/async-run.js';
import { readRegistry } from '../src/registry.js';
import { ModelSpecError } from '../src/model-spec.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunInState, waitRunSettled } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

/**
 * Реестр — в СВОЁМ каталоге (см. тот же комментарий в bridge.test.js).
 * Здесь это критично вдвойне: teardown ниже сносил `<reg>/../runs`, то есть
 * при реестре-в-корне-tmpdir — ОБЩИЙ /tmp/runs. Снос общего каталога уносил
 * envelope ранов, которые в этот момент ещё дописывались, и pollRun честно
 * докладывал «pid мёртв, envelope нет» -> синтетический error/killed вместо
 * completed. Именно так падал кейс «параллельные раны видят свои модели».
 */
async function tempRegistry() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-model-reg-'));
  return join(dir, 'runs.json');
}
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'bridge-task-'));
  return d;
}
async function makeTask(dir, text) {
  const f = join(dir, 'task.txt');
  await writeFile(f, text, 'utf8');
  return f;
}

describe('model-override', () => {
  it('runDsh: env проброс с model', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_DUMP_ENV__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURE_DSH },
        model: { provider: 'omniroute', model: 'cx/flash', reasoningEffort: 'high' },
      });
      // runDsh returns envelope, dump env is stdout as result
      assert.equal(env.status, 'completed');
      assert.match(env.result, /DSH_MODEL_PROVIDER=omniroute/);
      assert.match(env.result, /DSH_MODEL=cx\/flash/);
      assert.match(env.result, /DSH_REASONING_EFFORT=high/);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('startDsh: env проброс', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_DUMP_ENV__');
    try {
      const h = await startDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        env: { DSH_BINARY: FIXTURE_DSH },
        model: { provider: 'omniroute', model: 'a/b', reasoningEffort: 'low' },
      });
      const { envelope } = await waitRunSettled(h.runId, { waitMs: 3000, registryPath: reg });
      assert.ok(envelope);
      assert.match(envelope.result, /DSH_MODEL_PROVIDER=omniroute/);
      assert.match(envelope.result, /DSH_MODEL=a\/b/);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('opts.env.DSH_MODEL* без opts.model не доходит', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_DUMP_ENV__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: {
          DSH_BINARY: FIXTURE_DSH,
          DSH_MODEL_PROVIDER: 'evil',
          DSH_MODEL: 'evil/model',
          DSH_REASONING_EFFORT: 'high',
        },
      });
      assert.equal(env.status, 'completed');
      assert.match(env.result, /DSH_MODEL_PROVIDER=\n/);
      assert.match(env.result, /DSH_MODEL=\n/);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('opts.env не подменяет opts.model', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_DUMP_ENV__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURE_DSH, DSH_MODEL_PROVIDER: 'evil', DSH_MODEL: 'evil' },
        model: { provider: 'good', model: 'real' },
      });
      assert.match(env.result, /DSH_MODEL_PROVIDER=good/);
      assert.match(env.result, /DSH_MODEL=real/);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('sync: DSH_STEER_FILE из opts.env доходит (регрессия v1)', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_DUMP_ENV__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURE_DSH, DSH_STEER_FILE: '/tmp/steer' },
      });
      assert.match(env.result, /DSH_STEER_FILE=\/tmp\/steer/);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('model в реестре (v1 транзиентно — проверяем до удаления)', async () => {
    // Для v1 запись удаляется сразу после завершения, так что проверим через перехват putRun?
    // Проще проверить async путь: запись живёт.
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_HANG__');
    try {
      const h = await startDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        env: { DSH_BINARY: FIXTURE_DSH },
        model: { provider: 'omniroute', model: 'm' },
      });
      const rec = await readRegistry(reg);
      assert.deepEqual(rec[h.runId].model, { provider: 'omniroute', model: 'm' });
      // cleanup
      const { killRun } = await import('../src/async-run.js');
      await killRun(h.runId, { registryPath: reg });
    } finally {
      await rmTestDir(dir);
      try {
        await rmTestDir(dirname(reg));
      } catch {}
    }
  });
  it('невалидный объект бросает до spawn (строка вместо объекта)', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const pidFile = join(tmpdir(), `pid-${Date.now()}.txt`);
    const taskFile = await makeTask(dir, 'hello');
    try {
      await assert.rejects(
        () =>
          runDsh({
            taskFile,
            cwd: dir,
            registryPath: reg,
            env: { DSH_BINARY: FIXTURE_DSH, FAKE_PIDFILE: pidFile },
            model: 'omniroute/model',
          }),
        ModelSpecError,
      );
      // fake not spawned — pid file not created
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(pidFile), false);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
      await rm(pidFile, { force: true });
    }
  });
  it('невалидный объект бросает до spawn (плохой effort)', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, 'hello');
    try {
      await assert.rejects(
        () =>
          runDsh({
            taskFile,
            cwd: dir,
            registryPath: reg,
            env: { DSH_BINARY: FIXTURE_DSH },
            model: { provider: 'p', model: 'm', reasoningEffort: 'bad' },
          }),
        ModelSpecError,
      );
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('startDsh невалидный тоже до spawn', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, 'hello');
    try {
      await assert.rejects(
        () =>
          startDsh({
            taskFile,
            cwd: dir,
            registryPath: reg,
            env: { DSH_BINARY: FIXTURE_DSH },
            model: { provider: '', model: 'm' },
          }),
        ModelSpecError,
      );
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('envelope с невалидным model -> malformed_output', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_ENVELOPE_BAD_MODEL__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: { DSH_BINARY: FIXTURE_DSH },
      });
      assert.equal(env.status, 'error');
      assert.equal(env.error.code, 'malformed_output');
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('envelope с валидным model пробрасывается', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_ENVELOPE_WITH_MODEL__');
    try {
      const env = await runDsh({
        taskFile,
        cwd: dir,
        registryPath: reg,
        timeoutMs: 5000,
        env: {
          DSH_BINARY: FIXTURE_DSH,
          FAKE_ENVELOPE_MODEL: JSON.stringify({ provider: 'omniroute', model: 'cx/flash', reasoningEffort: 'high' }),
        },
      });
      assert.equal(env.status, 'completed');
      assert.deepEqual(env.model, { provider: 'omniroute', model: 'cx/flash', reasoningEffort: 'high' });
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('параллельные раны видят свои модели', async () => {
    const dir1 = await tempDir();
    const dir2 = await tempDir();
    const reg = await tempRegistry();
    const t1 = await makeTask(dir1, '__FAKE_DUMP_ENV__');
    const t2 = await makeTask(dir2, '__FAKE_DUMP_ENV__');
    try {
      const h1 = await startDsh({
        taskFile: t1,
        cwd: dir1,
        registryPath: reg,
        env: { DSH_BINARY: FIXTURE_DSH },
        model: { provider: 'omniroute', model: 'm1', reasoningEffort: 'low' },
      });
      const h2 = await startDsh({
        taskFile: t2,
        cwd: dir2,
        registryPath: reg,
        env: { DSH_BINARY: FIXTURE_DSH },
        model: { provider: 'omniroute', model: 'm2', reasoningEffort: 'high' },
      });
      const r1 = await waitRunInState(h1.runId, 'completed', { waitMs: 3000, registryPath: reg });
      const r2 = await waitRunInState(h2.runId, 'completed', { waitMs: 3000, registryPath: reg });
      assert.match(r1.envelope.result, /DSH_MODEL=m1/);
      assert.match(r2.envelope.result, /DSH_MODEL=m2/);
    } finally {
      await rmTestDir(dir1);
      await rmTestDir(dir2);
      await rmTestDir(dirname(reg));
    }
  });
  it('CLI run --model валидный и невалидный exit 2', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, 'hello');
    const cli = resolve('tools/dsh-bridge/bin/dsh-bridge.js');
    try {
      // valid
      const ok = await new Promise((res) => {
        const c = spawn(
          'node',
          [cli, 'run', '--task-file', taskFile, '--model', 'omniroute/cx/model:high', '--cwd', dir],
          { env: { ...process.env, DSH_BINARY: FIXTURE_DSH, DSH_BRIDGE_RUNS_FILE: reg } },
        );
        let out = '';
        c.stdout.on('data', (d) => (out += String(d)));
        c.stderr.on('data', (d) => (out += String(d)));
        c.on('close', (code) => res({ code, out }));
      });
      assert.equal(ok.code, 0);
      // invalid -> exit 2
      const bad = await new Promise((res) => {
        const c = spawn('node', [cli, 'run', '--task-file', taskFile, '--model', 'bad', '--cwd', dir], {
          env: { ...process.env, DSH_BINARY: FIXTURE_DSH, DSH_BRIDGE_RUNS_FILE: reg },
        });
        let err = '';
        c.stderr.on('data', (d) => (err += String(d)));
        c.stdout.on('data', () => {});
        c.on('close', (code) => res({ code, err }));
      });
      assert.equal(bad.code, 2);
      assert.match(bad.err, /model/i);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('CLI P1: невалидный envelope с model не подавляет malformed_output (regression)', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, '__FAKE_ENVELOPE_BAD_MODEL__');
    const cli = resolve('tools/dsh-bridge/bin/dsh-bridge.js');
    try {
      const out = await new Promise((res) => {
        const c = spawn('node', [cli, 'run', '--task-file', taskFile, '--cwd', dir], {
          env: { ...process.env, DSH_BINARY: FIXTURE_DSH, DSH_BRIDGE_RUNS_FILE: reg },
        });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => (stdout += String(d)));
        c.stderr.on('data', (d) => (stderr += String(d)));
        c.on('close', (code) => res({ code, stdout, stderr }));
      });
      assert.equal(out.code, 0, `stderr: ${out.stderr}`);
      const lines = out.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      const parsed = JSON.parse(last);
      assert.equal(parsed.v, 1);
      assert.equal(parsed.status, 'error');
      assert.equal(parsed.error.code, 'malformed_output');
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('CLI P2: --model без значения → exit 2', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, 'hello');
    const cli = resolve('tools/dsh-bridge/bin/dsh-bridge.js');
    try {
      const r = await new Promise((res) => {
        const c = spawn('node', [cli, 'run', '--task-file', taskFile, '--model'], {
          env: { ...process.env, DSH_BINARY: FIXTURE_DSH, DSH_BRIDGE_RUNS_FILE: reg },
        });
        let stderr = '';
        c.stderr.on('data', (d) => (stderr += String(d)));
        c.stdout.on('data', () => {});
        c.on('close', (code) => res({ code, stderr }));
      });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--model/i);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
  it('CLI P2: --model со значением-опцией → exit 2', async () => {
    const dir = await tempDir();
    const reg = await tempRegistry();
    const taskFile = await makeTask(dir, 'hello');
    const cli = resolve('tools/dsh-bridge/bin/dsh-bridge.js');
    try {
      const r = await new Promise((res) => {
        const c = spawn('node', [cli, 'run', '--task-file', taskFile, '--model', '--cwd', '--cwd', dir], {
          env: { ...process.env, DSH_BINARY: FIXTURE_DSH, DSH_BRIDGE_RUNS_FILE: reg },
        });
        let stderr = '';
        c.stderr.on('data', (d) => (stderr += String(d)));
        c.stdout.on('data', () => {});
        c.on('close', (code) => res({ code, stderr }));
      });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--model/i);
    } finally {
      await rmTestDir(dir);
      await rmTestDir(dirname(reg));
    }
  });
});
