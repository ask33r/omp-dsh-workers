/**
 * Steer-канал: доставка сообщений в ИДУЩИЙ ход headless-рана.
 *
 * DSH умеет это нативно — `agent.steer(msg)` кладёт сообщение на следующий шаг
 * текущего хода и будит драйвер (dsh-agent-loop:399). Не хватает только
 * транспорта в one-shot процесс: снаружи в файл дописывают JSONL-строки, здесь
 * их читают и передают в agent.
 *
 * Контракт: docs/contracts/dsh-steer-channel-v1.md
 */
import { openSync, closeSync, readSync, fstatSync, writeFileSync } from "node:fs";

/** Интервал опроса. fs.watch не используем: пропускает события на части ФС. */
export const POLL_INTERVAL_MS = 150;

/**
 * Разбирает одну строку канала. Возвращает текст или null, если строка битая.
 */
export function parseSteerLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const text = parsed.text;
  if (typeof text !== "string" || text === "") return null;
  return text;
}

/**
 * Читает новые ЦЕЛЫЕ строки от offset. Неполный хвост без "\n" не трогает —
 * он дочитается следующим опросом, когда писавший допишет перевод строки.
 *
 * @returns {{lines: string[], offset: number}} новый offset учитывает только
 *          обработанные целые строки.
 */
export function readNewLines(path, offset) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    // Файла ещё нет — значит никто ничего не слал. Это норма.
    return { lines: [], offset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset };
    const length = size - offset;
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, offset);
    const text = buf.subarray(0, read).toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { lines: [], offset };
    const complete = text.slice(0, lastNewline);
    return {
      lines: complete.split("\n"),
      offset: offset + Buffer.byteLength(complete, "utf8") + 1,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Запускает опрос канала и передаёт каждое сообщение в agent.steer().
 *
 * Стартовать ТОЛЬКО после того, как ход запрошен (agent.followup): иначе
 * сообщение попадёт в next-step ещё не начатого хода.
 *
 * @returns {{stop: () => void}} stop обязателен в finally — висящий таймер не
 *          даст процессу выйти.
 */
export function startSteerChannel(agent, steerFile, deps = {}) {
  const {
    createUserMessage,
    intervalMs = POLL_INTERVAL_MS,
    onWarn = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = deps;

  let offset = 0;
  let stopped = false;

  const writeOffset = () => {
    try {
      writeFileSync(`${steerFile}.offset`, String(offset), "utf8");
    } catch {
      // Отчёт о доставке — вспомогательный: не роняем ран, если он не пишется.
    }
  };

  const drain = () => {
    if (stopped) return;
    const { lines, offset: next } = readNewLines(steerFile, offset);
    if (next === offset) return;
    offset = next;
    for (const line of lines) {
      const text = parseSteerLine(line);
      if (text === null) {
        if (line.trim() !== "") onWarn(`steer: skipped a malformed line: ${line.slice(0, 120)}`);
        continue;
      }
      agent.steer(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
    }
    writeOffset();
  };

  const timer = setIntervalFn(drain, intervalMs);
  // Опрос не должен сам по себе держать процесс живым.
  if (typeof timer?.unref === "function") timer.unref();

  return {
    stop() {
      if (stopped) return;
      // Последний дренаж ДО остановки: сообщение могло прийти между тиками.
      // Всё, что не успело — останется в файле, и расхождение размера с
      // .offset честно покажет вызывающему, что оно не доставлено.
      drain();
      stopped = true;
      clearIntervalFn(timer);
      writeOffset();
    },
  };
}
