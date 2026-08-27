/**
 * Общая оснастка тестов, которые ловят гонки вокруг финализации рана.
 *
 * Обе гонки (`pollrun-envelope-race`, `pollrun-exitcode-race`) воспроизводятся
 * одной и той же постановкой: заведомо мёртвый pid в реестре + envelope,
 * появляющийся на диске ровно так же, как его кладёт мост (tmp + `link`).
 * Держать эту постановку в двух копиях значило бы, что подкрутка одной копии
 * молча расходится со второй — а тесты обязаны воспроизводить ОДИН и тот же
 * порядок событий, иначе они проверяют разные баги.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Гарантированно мёртвый pid: поднимаем тривиальный процесс и дожидаемся его
 * выхода. Реального «наблюдателя» у такого рана нет — ровно как у рана чужого
 * процесса, который уже упал или ещё не дописал envelope.
 */
export async function deadPid() {
  const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.once('close', r));
  return pid;
}

/**
 * Пишет envelope так же, как это делает finalizeIfAbsent в мосте: tmp + link,
 * то есть «создать, если ещё нет». Это принципиально для теста: если pollRun
 * успел закрепить свой синтетический killed, настоящий envelope проиграет
 * гонку и будет отброшен — именно так теряется результат успешного рана.
 */
export async function linkEnvelopeIfAbsent(envelopeFile, envelope) {
  const tmp = `${envelopeFile}.tmp.${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  try {
    await link(tmp, envelopeFile);
  } catch {
    /* EEXIST — кто-то уже закрепил свой envelope, наш отбрасывается */
  }
  await unlink(tmp).catch(() => {});
}

/** Каталог кейса с реестром внутри: runs/ приватный, никто чужой в него не пишет. */
export async function makeRaceCtx(prefix = 'pollrun-race-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const registryPath = join(dir, 'runs.json');
  const runsDir = join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return { dir, registryPath, runsDir };
}
