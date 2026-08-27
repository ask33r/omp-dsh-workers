import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startDsh, killRun, sendToRun } from '../src/async-run.js';
import { getRun, removeRun } from '../src/registry.js';
import { rmTestDir } from './tmp-cleanup.js';
import { waitRunSettled } from './wait-helpers.js';

const FIXTURE_DSH = resolve(join(import.meta.dirname, 'fixtures', 'dsh'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Изолированный реестр + cwd на один кейс. */
async function withRun(task) {
  const dir = await mkdtemp(join(tmpdir(), 'send-to-run-'));
  const registryPath = join(dir, 'runs.json');
  const taskFile = join(dir, 'task.txt');
  await writeFile(taskFile, task, 'utf8');
  const handle = await startDsh({
    taskFile,
    cwd: dir,
    registryPath,
    timeoutMs: 20000,
    env: { DSH_BINARY: FIXTURE_DSH },
  });
  return {
    dir,
    registryPath,
    handle,
    async cleanup() {
      try {
        await killRun(handle.runId, { registryPath, graceMs: 300 });
      } catch {}
      await rmTestDir(dir);
    },
  };
}

const linesOf = (raw) => raw.split('\n').filter((l) => l.trim() !== '');

describe('sendToRun', () => {
  it('startDsh заводит steerFile и кладёт его в реестр', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      const entry = await getRun(ctx.handle.runId, ctx.registryPath);
      assert.ok(entry.steerFile, 'steerFile должен быть в записи реестра');
      assert.match(entry.steerFile, /\.steer\.jsonl$/);
    } finally {
      await ctx.cleanup();
    }
  });

  it('доставляет сообщение живому рану строкой JSONL (раннер читает канал)', async () => {
    // delivered честный: подтверждает не appendFile, а то, что раннер реально
    // вычитал байты (см. __FAKE_STEER_READER__ в fake-dsh.js) — без читателя
    // тот же вызов вернул бы delivered:false, см. тест ниже про __FAKE_HANG__.
    const ctx = await withRun('__FAKE_STEER_READER__');
    try {
      const res = await sendToRun(ctx.handle.runId, 'пиши в src/', { registryPath: ctx.registryPath });
      assert.equal(res.delivered, true);
      assert.equal(
        res.status,
        'delivered',
        'трёхзначный статус (P1 п.4, раунд 2): подтверждённая доставка — "delivered"',
      );
      assert.ok(res.waitedMs >= 0, 'waitedMs присутствует и неотрицателен');

      const raw = await readFile(res.steerFile, 'utf8');
      const lines = linesOf(raw);
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.v, 1);
      assert.equal(parsed.text, 'пиши в src/');
      assert.ok(parsed.sentAt, 'sentAt проставляется');
    } finally {
      await ctx.cleanup();
    }
  });

  it('канал никто не читает, но ран жив: status="pending" — не undeliverable (P1 п.4, раунд 2)', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      const res = await sendToRun(ctx.handle.runId, 'в пустоту', { registryPath: ctx.registryPath });
      assert.equal(res.delivered, false, 'без подтверждения чтения честно нельзя считать доставленным');
      // Ран жив (просто канал никто не вычитывает) — это НЕ то же самое, что
      // "потеряно навсегда": вызывающий не должен дублировать сообщение
      // другим маршрутом, пока ран жив и однажды его прочитает.
      assert.equal(res.status, 'pending', 'живой ран без читателя — "pending", а не "undeliverable"');
      assert.ok(res.waitedMs > 0, 'sendToRun должен был реально прождать окно доставки');

      const raw = await readFile(res.steerFile, 'utf8');
      const lines = linesOf(raw);
      assert.equal(lines.length, 1, 'сообщение всё равно попало в файл — просто его не прочитали');
      assert.equal(JSON.parse(lines[0]).text, 'в пустоту');
    } finally {
      await ctx.cleanup();
    }
  });

  it('сохраняет порядок нескольких сообщений', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      for (const text of ['раз', 'два', 'три']) {
        await sendToRun(ctx.handle.runId, text, { registryPath: ctx.registryPath });
      }
      const raw = await readFile(
        ctx.handle.runId ? (await getRun(ctx.handle.runId, ctx.registryPath)).steerFile : '',
        'utf8',
      );
      assert.deepEqual(
        linesOf(raw).map((l) => JSON.parse(l).text),
        ['раз', 'два', 'три'],
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it('pendingBytes показывает непрочитанное: без раннера растёт с каждым сообщением (delivered:false)', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      // Фикстура fake-dsh не читает канал, поэтому .offset никто не пишет —
      // ровно та ситуация, когда сообщение остаётся недоставленным: честный
      // delivered:false у ОБОИХ вызовов, а не только растущий pendingBytes.
      const first = await sendToRun(ctx.handle.runId, 'первое', { registryPath: ctx.registryPath });
      const second = await sendToRun(ctx.handle.runId, 'второе', { registryPath: ctx.registryPath });
      assert.equal(first.delivered, false);
      assert.equal(second.delivered, false);
      assert.equal(first.status, 'pending', 'ран жив весь тест — недоставленное здесь "pending", не "undeliverable"');
      assert.equal(second.status, 'pending');
      assert.ok(second.pendingBytes > first.pendingBytes, 'непрочитанное должно расти');
      assert.equal(second.pendingBytes, (await stat(second.steerFile)).size);
    } finally {
      await ctx.cleanup();
    }
  });

  it('учитывает .offset раннера: прочитанное не считается непрочитанным', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      const res = await sendToRun(ctx.handle.runId, 'прочитано', { registryPath: ctx.registryPath });
      const size = (await stat(res.steerFile)).size;
      // Раннер отчитался, что вычитал весь файл.
      await writeFile(`${res.steerFile}.offset`, String(size), 'utf8');

      const next = await sendToRun(ctx.handle.runId, 'ещё', { registryPath: ctx.registryPath });
      assert.ok(next.pendingBytes > 0, 'новое сообщение ещё не прочитано');
      assert.ok(next.pendingBytes < (await stat(res.steerFile)).size, 'но прочитанное уже не учитывается');
    } finally {
      await ctx.cleanup();
    }
  });

  it('завершённый ран: delivered=false, status="undeliverable", в канал не пишем', async () => {
    const ctx = await withRun('__FAKE_ENVELOPE_OK__ короткая задача');
    try {
      const done = await waitRunSettled(ctx.handle.runId, { waitMs: 10000, registryPath: ctx.registryPath });
      assert.notEqual(done.state, 'running');

      const res = await sendToRun(ctx.handle.runId, 'поздно', { registryPath: ctx.registryPath });
      assert.equal(res.delivered, false);
      // Ран уже был не running ДО отправки (ранний return) — гарантированно
      // не доставлено, а не "может ещё прочитают" (P1 п.4, раунд 2).
      assert.equal(res.status, 'undeliverable');
      assert.equal(res.waitedMs, 0, 'завершённый ран отсекается ДО ожидания доставки — ждать нечего');

      let raw = '';
      try {
        raw = await readFile(res.steerFile, 'utf8');
      } catch {
        raw = '';
      }
      assert.equal(linesOf(raw).length, 0, 'в завершённый ран писать нечего');
    } finally {
      await ctx.cleanup();
    }
  });

  it('ран завершается ПОСРЕДИ окна ожидания подтверждения, не прочитав канал: status="undeliverable"', async () => {
    // Отличается от предыдущего теста: там ран УЖЕ был не running к моменту
    // вызова (ранний return, waitedMs:0). Здесь ран running в начале вызова —
    // запись в канал происходит, — но умирает ПОКА sendToRun ждёт offset.
    // Это отдельная ветка (перечитывание состояния ПОСЛЕ таймаута ожидания),
    // а не тот же самый ранний return.
    const ctx = await withRun('__FAKE_HANG__');
    try {
      const killSoon = sleep(100).then(() =>
        killRun(ctx.handle.runId, { registryPath: ctx.registryPath, graceMs: 300 }),
      );
      const res = await sendToRun(ctx.handle.runId, 'не успеет', { registryPath: ctx.registryPath });
      await killSoon;

      assert.equal(res.delivered, false);
      assert.equal(res.status, 'undeliverable', 'ран умер, не прочитав канал — offset уже никогда не дойдёт');
      assert.ok(res.waitedMs > 0, 'на этом пути ожидание реально было (в отличие от раннего return выше)');
    } finally {
      await ctx.cleanup();
    }
  });

  it('неизвестный runId и пустой текст — явные ошибки, не тихий no-op', async () => {
    const ctx = await withRun('__FAKE_HANG__');
    try {
      await assert.rejects(
        () => sendToRun('нет-такого-рана', 'текст', { registryPath: ctx.registryPath }),
        /unknown runId/,
      );
      await assert.rejects(
        () => sendToRun(ctx.handle.runId, '', { registryPath: ctx.registryPath }),
        /non-empty string/,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it('выметенный из реестра завершённый ран (envelope на диске): undeliverable, не бросает', async () => {
    // reapOrphans выметает терминальные записи реестра за ~30 секунд, а
    // envelope остаётся на диске навсегда: после этого sendToRun уже не видит
    // записи, но ран прекрасно известен и результат лежит на диске. По
    // контракту (dsh-bridge-async-v2, ~строка 181) это «ран в терминальном
    // состоянии, доставка невозможна» — штатный undeliverable, а не throw.
    const ctx = await withRun('__FAKE_ENVELOPE_OK__ короткая задача');
    try {
      const done = await waitRunSettled(ctx.handle.runId, { waitMs: 10000, registryPath: ctx.registryPath });
      assert.notEqual(done.state, 'running');

      // Имитируем выметание: запись удалена, envelope остался.
      const removed = await removeRun(ctx.handle.runId, ctx.registryPath);
      assert.equal(removed, true, 'запись реально удалена из реестра');

      const res = await sendToRun(ctx.handle.runId, 'поздно', { registryPath: ctx.registryPath });
      assert.equal(res.delivered, false);
      assert.equal(res.status, 'undeliverable', 'завершённый ран без записи реестра — undeliverable, а не throw');
      assert.equal(res.waitedMs, 0, 'доставка отсекается до ожидания — ждать нечего');
      assert.match(res.steerFile, /\.steer\.jsonl$/, 'steerFile указывает на канал рана на диске');
      assert.equal(typeof res.pendingBytes, 'number');

      let raw = '';
      try {
        raw = await readFile(res.steerFile, 'utf8');
      } catch {
        raw = '';
      }
      assert.equal(linesOf(raw).length, 0, 'в завершённый ран писать нечего');
    } finally {
      await ctx.cleanup();
    }
  });

  it('ран, которого не было никогда (ни записи, ни envelope) — по-прежнему бросает', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'send-to-run-'));
    try {
      const registryPath = join(dir, 'runs.json');
      await assert.rejects(() => sendToRun('нет-такого-рана-вообще', 'текст', { registryPath }), /unknown runId/);
    } finally {
      await rmTestDir(dir);
    }
  });
});
