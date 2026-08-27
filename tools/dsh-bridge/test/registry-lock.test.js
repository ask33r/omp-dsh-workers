import './node-only.js';

// Межпроцессный лок реестра (P0, дефект 1 кросс-ревью): putRun/updateRun/
// removeRun/clearRegistry/reapOrphans делали read-modify-write БЕЗ лока —
// конкурентные вызовы (OMP-сессия с extension, CLI dsh-bridge, сторож) молча
// затирали чужие записи друг друга (lost update).
//
// Тесты гоняют мутации из ОДНОГО процесса параллельно (Promise.all) — этого
// достаточно, чтобы поймать гонку в самой read-modify-write паре: withRegistryLock
// одинаково сериализует и внутрипроцессные, и межпроцессные вызовы (лок живёт
// в файловой системе, а не в памяти), так что тест внутри одного процесса —
// не менее строгая проверка, чем настоящий кросс-процессный сценарий.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { putRun, updateRun, getRun, readRegistry, withRegistryLock } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';

async function withTempRegistry(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'registry-lock-'));
  const registryPath = join(dir, 'runs.json');
  try {
    await fn(registryPath);
  } finally {
    await rmTestDir(dir);
  }
}

function fakeEntry(extra = {}) {
  return { pid: 1234, pgid: 1234, dshSessionId: null, state: 'running', startedAt: new Date().toISOString(), ...extra };
}

describe('withRegistryLock — межпроцессный лок реестра', () => {
  it('20 конкурентных putRun с разными runId — в реестре все 20, ни одна запись не потеряна', async () => {
    await withTempRegistry(async (registryPath) => {
      const ids = Array.from({ length: 20 }, (_, i) => `run-${i}`);
      await Promise.all(ids.map((id) => putRun(id, fakeEntry({ label: id }), registryPath)));

      const reg = await readRegistry(registryPath);
      assert.equal(Object.keys(reg).length, 20, `ожидали 20 записей, получили ${Object.keys(reg).length}`);
      for (const id of ids) {
        assert.ok(reg[id], `запись ${id} потеряна (lost update)`);
        assert.equal(reg[id].label, id);
      }
    });
  });

  it('конкурентные updateRun двух разных полей одной записи — оба изменения выживают', async () => {
    await withTempRegistry(async (registryPath) => {
      await putRun('shared', fakeEntry({ fieldA: 'init', fieldB: 'init' }), registryPath);

      await Promise.all([
        updateRun('shared', { fieldA: 'from-a' }, registryPath),
        updateRun('shared', { fieldB: 'from-b' }, registryPath),
      ]);

      const entry = await getRun('shared', registryPath);
      assert.equal(entry.fieldA, 'from-a', 'изменение fieldA потеряно (lost update)');
      assert.equal(entry.fieldB, 'from-b', 'изменение fieldB потеряно (lost update)');
    });
  });

  it('протухший (>10с) лок не блокирует навсегда: захватывается заново', async () => {
    await withTempRegistry(async (registryPath) => {
      const lockPath = `${registryPath}.lock`;
      await writeFile(lockPath, `999999999 ${new Date().toISOString()}\n`, 'utf8');
      // «Чужой» протухший лок: mtime на 20 секунд в прошлом — владелец должен
      // считаться умершим между open() и unlink().
      const staleTime = new Date(Date.now() - 20000);
      await utimes(lockPath, staleTime, staleTime);

      const t0 = Date.now();
      await putRun('after-stale', fakeEntry(), registryPath);
      const elapsed = Date.now() - t0;

      assert.ok(elapsed < 1500, `протухший лок не должен ждать полный таймаут захвата, заняло ${elapsed}мс`);
      const entry = await getRun('after-stale', registryPath);
      assert.ok(entry, 'запись должна была появиться после снятия протухшего лока');
    });
  });

  it('lock-файл убирается после операции (не остаётся висеть)', async () => {
    await withTempRegistry(async (registryPath) => {
      await putRun('cleanup-check', fakeEntry(), registryPath);
      const lockPath = `${registryPath}.lock`;
      assert.equal(existsSync(lockPath), false, 'лок-файл должен быть снят после putRun');
    });
  });

  // P0, дефект 1 (раунд 2 кросс-ревью): release раньше делал безусловный unlink
  // лок-файла по ПУТИ, не проверяя владение. Если наш лок был признан
  // протухшим ДРУГИМ waiter'ом (мы на самом деле живы, просто медленные) и
  // перезахвачен — наш release сносил бы ЕГО активный лок, открывая дорогу
  // третьему waiter'у зайти, пока второй ещё работает (lost update). Токен
  // захвата (pid:uuid) в файле лока — единственный способ release'у отличить
  // «это всё ещё мой лок» от «его давно перехватили».
  it('release не сносит чужой лок: если владение потеряно (файл лока подменили чужим токеном), release молчит', async () => {
    await withTempRegistry(async (registryPath) => {
      const lockPath = `${registryPath}.lock`;
      const foreignToken = 'foreign-pid:foreign-uuid-not-ours';

      // withRegistryLock — тот же путь, которым идут putRun/updateRun/etc:
      // держим лок, а ПОКА держим — эмулируем гонку: кто-то счёл наш лок
      // протухшим, снял его и создал свой (foreignToken).
      await withRegistryLock(registryPath, async () => {
        await writeFile(lockPath, `${foreignToken} ${new Date().toISOString()}\n`, 'utf8');
      });

      const raw = await readFile(lockPath, 'utf8');
      assert.ok(
        raw.startsWith(foreignToken),
        `release не должен был снести чужой лок — ожидали файл с ${foreignToken}, получили: ${raw}`,
      );
    });
  });

  // P0, дефект 1 (раунд 2): раньше протухший лок снимался и retry open('wx')
  // шёл НЕМЕДЛЕННО, без бэкоффа — несколько waiter'ов, увидевших один и тот же
  // протухший лок, кидались перезахватывать его одновременно (толпа). С
  // токеном владения (см. тест выше) потеря данных исключена даже при толпе,
  // но сценарий «много конкурентных putRun вокруг заранее протухшего лока»
  // остаётся регрессионной проверкой на потерю записей при такой толпе.
  it('гонка вокруг заранее протухшего лока: 10 конкурентных putRun — ни одна запись не потеряна', async () => {
    await withTempRegistry(async (registryPath) => {
      const lockPath = `${registryPath}.lock`;
      await writeFile(lockPath, `999999999:stale-fake-token ${new Date().toISOString()}\n`, 'utf8');
      const staleTime = new Date(Date.now() - 20000);
      await utimes(lockPath, staleTime, staleTime);

      const ids = Array.from({ length: 10 }, (_, i) => `race-${i}`);
      await Promise.all(ids.map((id) => putRun(id, fakeEntry({ label: id }), registryPath)));

      const reg = await readRegistry(registryPath);
      assert.equal(Object.keys(reg).length, 10, `ожидали 10 записей, получили ${Object.keys(reg).length}`);
      for (const id of ids) {
        assert.ok(reg[id], `запись ${id} потеряна в гонке вокруг протухшего лока`);
      }
    });
  });
});
