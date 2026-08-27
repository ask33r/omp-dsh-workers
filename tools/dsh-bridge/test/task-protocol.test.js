import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NEED_INPUT_PROTOCOL, withAskProtocol } from '../src/task-protocol.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunInState } from './wait-helpers.js';

describe('withAskProtocol', () => {
  it('по умолчанию выключен: ядро bridge передаёт бриф дословно', () => {
    assert.equal(withAskProtocol('почини тесты'), 'почини тесты');
  });

  it('дописывает протокол вопроса отдельным блоком в конец задачи', () => {
    const out = withAskProtocol('почини тесты', true);
    assert.ok(out.startsWith('почини тесты'), 'бриф остаётся первым и неизменным');
    assert.ok(out.includes('NEED_INPUT:'), 'протокол дописан');
    assert.ok(out.length > 'почини тесты'.length);
  });

  it('выключается явно: дословный бриф без единого лишнего символа', () => {
    assert.equal(withAskProtocol('почини тесты', false), 'почини тесты');
  });

  it('включается только строгим true, а не любым истинным значением', () => {
    assert.equal(withAskProtocol('задача', 1), 'задача');
    assert.equal(withAskProtocol('задача', 'yes'), 'задача');
  });

  it('не дублирует протокол, если он уже в брифе', () => {
    const once = withAskProtocol('задача', true);
    const twice = withAskProtocol(once, true);
    assert.equal(twice, once);
  });

  it('пустая задача остаётся пустой: протокол сам по себе не задача', () => {
    assert.equal(withAskProtocol('', true), '');
    assert.equal(withAskProtocol('   ', true), '   ');
  });

  it('протокол требует маркер именно последней строкой', () => {
    assert.match(NEED_INPUT_PROTOCOL, /last line/i);
    assert.match(NEED_INPUT_PROTOCOL, /NEED_INPUT:/);
  });
});

describe('state для рана, завершившегося вопросом', () => {
  it('need_input не маскируется под completed', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { startDsh, killRun } = await import('../src/async-run.js');

    const fixture = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));
    const dir = await mkdtemp(join(tmpdir(), 'need-input-state-'));
    const registryPath = join(dir, 'runs.json');
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '__FAKE_NEED_INPUT__ какой порт?', 'utf8');
    try {
      const h = await startDsh({
        taskFile,
        cwd: dir,
        registryPath,
        timeoutMs: 20000,
        env: { DSH_BINARY: fixture },
      });
      const done = await waitRunInState(h.runId, 'need_input', { waitMs: 15000, registryPath });
      assert.equal(done.envelope.status, 'need_input');
      assert.equal(done.state, 'need_input', 'ран закончился вопросом, а не результатом');
      try {
        await killRun(h.runId, { registryPath, graceMs: 200 });
      } catch {}
    } finally {
      await rmTestDir(dir);
    }
  });
});
