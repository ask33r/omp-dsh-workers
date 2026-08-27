import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { pollRun, renewLease } from "../../tools/dsh-bridge/src/index.js";
import { modelLine, sessionLine, errorPrefix, extractQuestion } from "./index.ts";

// Relay: наблюдает за ранами, запущенными ЭТОЙ сессией, и доставляет их события
// в чат директора как нативные сообщения агента (irc:incoming, followUp).
// Только раны, прошедшие через watchRun, порождают сообщения — чужие из реестра нет.
//
// Гарантия доставки — at-least-once поверх канала без квитанций. Родной vibe mode OMP
// решает ту же задачу иначе: owner-routed delivery sink + yield queue сессии — записи живут
// в очереди ДО успешной инжекции, и на каждом settle хода (включая Esc-аборт,
// agent-session.ts #endInFlight) зовётся requestIdleFlush. ExtensionAPI такой очереди не
// даёт (sendMessage → void), поэтому наш эквивалент — повтор анонса из envelope; он даже
// устойчивее: envelope лежит на диске и переживает рестарт процесса. Дедуп «синхронный
// dsh_wait vs авто-доставка» — зеркало acknowledgeDeliveries/resumeDeliveries родного
// vibe mode (см. acknowledgeRun).

export const RELAY_RENEW_MS = 60_000;
// Смоук 2026-08-26: Esc-аборт хода директора теряет очередь followUp безвозвратно (OMP
// сознательно не возобновляет ход из очереди после аборта — #drainStrandedQueuedMessages).
// Отсюда повторы: need_input напоминается, пока вопрос не закрыт dsh_answer'ом; терминальное
// событие повторяется, пока доставка не подтверждена началом хода. Интервал заметно больше
// цикла «сообщение → ход директора → реакция», чтобы повтор не дублировал живую работу.
export const NEED_INPUT_REANNOUNCE_MS = 120_000;
export const TERMINAL_REANNOUNCE_MS = 120_000;
// Предохранитель: повторяем анонс не бесконечно. Квитанция (см. noteMessageDelivered) —
// единственный признак доставки; хост расширения, который не эмитит message_start, иначе
// заставил бы relay слать один и тот же результат каждые 120 с до конца сессии. Три попытки
// ≈ 4 минуты на то, чтобы сообщение осело в контексте директора.
export const MAX_ANNOUNCE_ATTEMPTS = 3;

type WatchedEntry = {
  label: string;
  // Время последнего УСПЕШНОГО анонса по ключу события ("need_input"/"completed"/"error").
  // Была бинарная пометка (Set announced) — смоук показал, что «поставлено в очередь» ≠
  // «доставлено», поэтому от факта перешли к времени: от него считаются повторы.
  announcedAt: Map<string, number>;
  // Текст последнего анонса по ключу — по нему опознаётся квитанция: message_start несёт
  // ровно тот payload, который мы отдали в sendFollowUp (details.message).
  announcedText: Map<string, string>;
  // Сколько раз событие уходило в канал (первая отправка + повторы) — см. MAX_ANNOUNCE_ATTEMPTS.
  attempts: Map<string, number>;
  // Ключи событий с подтверждённой доставкой.
  delivered: Set<string>;
  lastRenewedAt: number;
  // Терминальное событие анонсировано. Текст кешируем и повторяем дословно: терминальное
  // состояние не меняется, опрашивать envelope дальше незачем.
  terminal?: { key: "completed" | "error"; text: string };
};

const watched = new Map<string, WatchedEntry>();
// lastRunByLabel: последний runId по label, выигрывает последний watchRun. Не чистится при unwatch,
// чтобы dsh_answer мог резолвить label даже после выметания записи из реестра (reapOrphans ≤30с).
const lastRunByLabel = new Map<string, string>();
// labelByRunId: обратная карта того же факта. Нужна ровно по той же причине и живёт ровно столько
// же: relay в сообщении сам предлагает `dsh_answer runId=<runId>`, а к моменту ответа запись рана
// из реестра уже выметена — метку взять неоткуда, и цепочка ⟨label⟩ рвалась на shortId.
const labelByRunId = new Map<string, string>();
let piRef: ExtensionAPI | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const RELAY_INTERVAL_MS = 1000;
let ticking = false;

/**
 * Квитанция доставки. index.ts зовёт из pi.on("message_start") — событие приходит с полным
 * сообщением (agent-session.ts: MessageStartEvent {message}), а сообщения ВХОДЯЩИЕ агент-цикл
 * эмитит перед вызовом модели (agent-loop.ts: emitInputMessages). Значит совпадение payload —
 * прямое доказательство, что наш followUp лёг в контекст хода, а не остался в очереди.
 *
 * ПОЧЕМУ не «начался ход» (было до раунда 3, находка Codex P1): followUp, влитый в УЖЕ
 * РАБОТАЮЩИЙ agent loop (agent-loop.ts: getFollowUpMessages → pendingMessages → continue),
 * не проходит через before_agent_start вовсе — тот эмитится только из внешнего prompt-пути
 * (agent-session.ts:5835). Директор, который в момент анонса ещё работал, прочитывал результат
 * и всё равно получал его дословный повтор каждые 120 с, пока не остановится.
 *
 * Сверяем и runId, и текст: у одного рана события разные (need_input → error при dsh_kill),
 * и квитанция на вопрос не должна закрывать результат.
 */
export function noteMessageDelivered(message: unknown): void {
  const m = message as
    | { role?: unknown; customType?: unknown; details?: { id?: unknown; message?: unknown } }
    | null
    | undefined;
  if (!m || typeof m !== "object") return;
  // Опознаём ТОЛЬКО по customType и details. Проверки `role === "custom"` здесь быть
  // не должно: живое сообщение поля role не имеет вовсе (в transcript оно ложится как
  // {type:"custom_message", customType, content, display, details, attribution} — см.
  // session/agent-session.ts:sendCustomMessage, где appMessage собирается именно из
  // этих полей). Требование role !== undefined отбрасывало КАЖДУЮ квитанцию ранним
  // return, из-за чего relay повторял каждое событие до исчерпания
  // MAX_ANNOUNCE_ATTEMPTS — три дубля в чате директора на один результат воркера.
  // Дефект прожил все тесты, потому что их хелпер deliveryOf синтезировал role сам.
  if (m.customType !== "irc:incoming") return;
  const runId = m.details?.id;
  const text = m.details?.message;
  if (typeof runId !== "string" || typeof text !== "string") return;
  const entry = watched.get(runId);
  if (!entry) return;
  for (const [key, announced] of entry.announcedText) {
    if (announced !== text) continue;
    entry.delivered.add(key);
    // Терминальное событие доставлено — наблюдать больше не за чем. need_input остаётся под
    // наблюдением: доставленный вопрос всё ещё ждёт dsh_answer (закрывает его unwatchRun),
    // но напоминать о нём уже незачем — он в контексте директора.
    if (entry.terminal?.key === key) {
      watched.delete(runId);
      stopPumpIfEmpty();
    }
    return;
  }
}

export function rememberPi(pi: ExtensionAPI): void {
  piRef = pi;
}

export function watchRun(runId: string, label: string): void {
  if (typeof runId !== "string" || runId.length === 0) return;
  const normLabel = typeof label === "string" && label.length > 0 ? label : runId.slice(0, 8);
  watched.set(runId, {
    label: normLabel,
    announcedAt: new Map<string, number>(),
    announcedText: new Map<string, string>(),
    attempts: new Map<string, number>(),
    delivered: new Set<string>(),
    lastRenewedAt: Date.now(),
  });
  lastRunByLabel.set(normLabel, runId);
  labelByRunId.set(runId, normLabel);
  ensurePump();
}

/**
 * Детерминированное закрытие need_input: index.ts зовёт из dsh_answer ПОСЛЕ того, как startDsh
 * принял resumeFromRunId, — вопрос закрыт именно успешным ответом, а не фактом отправки
 * сообщения когда-то раньше. Снимается только наблюдение — карты меток живут дальше (см.
 * комментарий у lastRunByLabel): они нужны следующему dsh_answer той же цепочки.
 */
export function unwatchRun(runId: string): void {
  watched.delete(runId);
  stopPumpIfEmpty();
}

/**
 * «Директор уже получил envelope синхронно» — зеркало acknowledgeDeliveries родного vibe mode
 * (vibe/runtime.ts: vibe_wait по settled-джобам гасит их авто-доставку). Зовёт index.ts из
 * dsh_wait после успешного возврата envelope по runId (не при таймауте ожидания).
 *
 * Терминальный статус — снять с наблюдения БЕЗ анонса: результат у директора в руках, это
 * подтверждённое знание, а не запись в очереди, которую мог убить Esc. need_input — наблюдение
 * оставить (вопрос по-прежнему ждёт dsh_answer), но напоминание отложить на полный
 * NEED_INPUT_REANNOUNCE_MS от момента ack: директор видел вопрос только что, напоминать
 * сразу — шум.
 */
export function acknowledgeRun(runId: string, state: string): void {
  const entry = watched.get(runId);
  if (!entry) return;
  if (state === "completed" || state === "error") {
    watched.delete(runId);
    stopPumpIfEmpty();
    return;
  }
  if (state === "need_input") {
    // Метку ставим даже если relay сам ещё не анонсировал: первый анонс сразу после того,
    // как директор прочитал вопрос через dsh_wait, — такой же дубль, как и повторный.
    entry.announcedAt.set("need_input", Date.now());
  }
}

export function resolveLabel(label: string): string | undefined {
  return lastRunByLabel.get(label);
}

/** Метка рана, который relay вёл в этой сессии. Переживает снятие с наблюдения (см. labelByRunId). */
export function resolveLabelForRun(runId: string): string | undefined {
  return labelByRunId.get(runId);
}

/**
 * Production-сброс состояния relay при смене сессии внутри живого процесса.
 *
 * ПОЧЕМУ вообще нужен: watched/lastRunByLabel/labelByRunId/timer — модульные, а OMP умеет
 * менять сессию без перезапуска процесса (session_switch/session_branch). Без сброса событие
 * рана СТАРОЙ сессии уехало бы followUp'ом в transcript НОВОЙ, а резолв метки отдал бы там
 * ран из прошлой сессии.
 *
 * ПОЧЕМУ раны при этом НЕ убиваем (в отличие от session_shutdown, где index.ts шлёт killRun):
 * процесс жив, чужая работа продолжается, раны остаются в реестре и достижимы через dsh_list —
 * убивать их на переключении вкладки было бы сюрпризом. Сбрасывается только наша подписка на
 * их события: перестать слать их в новую сессию — обязательно, обрывать саму работу — нет.
 *
 * piRef НЕ обнуляем: это канал ExtensionAPI уровня процесса (rememberPi зовётся один раз при
 * загрузке расширения), он адресует уже новую сессию — обнуление оставило бы relay немым навсегда.
 */
export function resetForSessionSwitch(): void {
  watched.clear();
  lastRunByLabel.clear();
  labelByRunId.clear();
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function ensurePump(): void {
  if (timer) return;
  if (watched.size === 0) return;
  const t: unknown = setInterval(() => {
    void tick();
  }, RELAY_INTERVAL_MS);
  timer = t as ReturnType<typeof setInterval>;
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

function stopPumpIfEmpty(): void {
  if (watched.size === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

// Возвращает признак ПОСТАНОВКИ В ОЧЕРЕДЬ, а не доставки. Больше кода здесь и не знает:
// ExtensionAPI.sendMessage объявлен как void (types.ts:1426) и внутри хоста лишь запускает
// session.sendCustomMessage(...) с собственным .catch, который гасит отказ в свой репортёр
// (modes/runtime-init.ts:59-71) — квитанции о записи в transcript до нас не доходит.
// Что гарантируем: канал есть и синхронного отказа не было. Чего не гарантируем: что запись
// действительно легла в transcript новой сессии.
// false — канала нет (pi ещё не запомнен или хост расширения не даёт sendMessage). Молчаливый
// return без сигнала однажды уже стоил потерянных событий: вызывающий помечал их отправленными
// и снимал ран с наблюдения навсегда.
function sendFollowUp(text: string, runId: string, label: string): boolean {
  if (!piRef) return false;
  const piAny = piRef as unknown as { sendMessage?: (payload: unknown, opts: unknown) => void };
  if (typeof piAny.sendMessage !== "function") return false;
  piAny.sendMessage(
    {
      customType: "irc:incoming",
      content: text,
      display: true,
      details: { id: runId, from: label, message: text },
      attribution: "agent",
    } as never,
    { triggerTurn: true, deliverAs: "followUp" },
  );
  return true;
}

// Единственное место, где событие получает метку времени анонса (см. sendFollowUp: это
// постановка в очередь без синхронного отказа канала, а не подтверждённая доставка).
// Инвариант прежний: помечаем ТОЛЬКО после успешной постановки — отказ канала (throw или
// отсутствующий sendMessage) не помечает ничего, попытка повторится на следующем тике.
// Снятия с наблюдения здесь больше нет вовсе — Esc-урок смоука 2026-08-26: очередь followUp
// не переживает аборт хода, поэтому закрытие детерминированное и живёт в tick() /
// unwatchRun() / acknowledgeRun(), а не в факте отправки.
function announce(runId: string, entry: WatchedEntry, key: string, text: string): boolean {
  let enqueued = false;
  try {
    enqueued = sendFollowUp(text, runId, entry.label);
  } catch {
    enqueued = false;
  }
  if (!enqueued) return false;
  entry.announcedAt.set(key, Date.now());
  entry.announcedText.set(key, text);
  entry.attempts.set(key, (entry.attempts.get(key) ?? 0) + 1);
  return true;
}

/** Попытки исчерпаны — повторять нечего (см. MAX_ANNOUNCE_ATTEMPTS). */
function attemptsExhausted(entry: WatchedEntry, key: string): boolean {
  return (entry.attempts.get(key) ?? 0) >= MAX_ANNOUNCE_ATTEMPTS;
}

function formatCompleted(envelope: unknown): string {
  const result = (envelope as { result?: string } | null | undefined)?.result ?? "";
  let text = result;
  const mLine = modelLine(envelope);
  if (mLine) text = text ? `${text}\n${mLine}` : mLine;
  const sLine = sessionLine(envelope);
  if (sLine) text = text ? `${text}\n${sLine}` : sLine;
  return text;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (watched.size === 0) {
      stopPumpIfEmpty();
      return;
    }
    if (!piRef) return;
    const ids = [...watched.keys()];
    for (const runId of ids) {
      const entry = watched.get(runId);
      if (!entry) continue;
      // Терминальное событие уже анонсировано: дальше ни pollRun (состояние не меняется),
      // ни renewLease (запись в реестре нам больше не нужна) — судьбу решает квитанция.
      if (entry.terminal) {
        const key = entry.terminal.key;
        // Доставку обычно закрывает сам noteMessageDelivered; сюда попадаем, если квитанция
        // пришла в момент, когда тик уже собрал список runId'ов.
        if (entry.delivered.has(key) || attemptsExhausted(entry, key)) {
          watched.delete(runId);
          continue;
        }
        const at = entry.announcedAt.get(key) ?? 0;
        if (Date.now() - at >= TERMINAL_REANNOUNCE_MS) {
          // Квитанции нет — сообщение в контекст директора не легло (Esc-аборт стрендит
          // очередь followUp). Повтор дословный: модель дедуплицирует смыслом.
          announce(runId, entry, key, entry.terminal.text);
        }
        continue;
      }
      // P1: продление аренды с cadence RELAY_RENEW_MS для любого ещё не закрытого рана.
      // Ран под наблюдением = его событие ещё не закрыто (у need_input — вопрос не отвечен),
      // и запись в реестре нужна живой: dsh_answer резолвит по ней фолбэком, dsh_list её
      // показывает, а reapOrphans выметает за ~30с. Терминальный после анонса сюда не
      // доходит — ветка выше выходит из итерации раньше.
      if (Date.now() - entry.lastRenewedAt >= RELAY_RENEW_MS) {
        try {
          await renewLease(runId);
          entry.lastRenewedAt = Date.now();
        } catch {
          // Аренда — подстраховка, не критический путь: глотаем ошибку и продолжаем опрос.
        }
      }
      let snap: { state: string; envelope: unknown; exitCode: number | null };
      try {
        snap = (await pollRun(runId, {})) as unknown as typeof snap;
      } catch {
        // Ретраим ЛЮБУЮ ошибку, включая «нет такого runId», хотя постоянная ошибка держит ран
        // под наблюдением вечно (холостой pollRun раз в секунду + renewLease раз в минуту).
        // ПОЧЕМУ не снимаем по «неизвестному runId»: отличить его от временного сбоя нельзя.
        // pollRun бросает `unknown runId (no registry entry, no envelope)` (async-run.js:616)
        // на пустой ответ getRun, а readRegistry (registry.js:239-252) отдаёт `{}` на ЛЮБОЙ
        // не-ENOENT сбой чтения (EACCES/EMFILE/битый JSON) — значит живой ран, чей envelope
        // ещё не написан, выглядит в этот момент ровно как несуществующий. Снятие по такой
        // ошибке молча теряло бы событие живого рана, а это дороже холостого тика.
        continue;
      }
      // Сессия могла смениться, пока мы висели на await'ах выше (resetForSessionSwitch чистит
      // watched). Сверяем идентичность записи, а не наличие runId: после сброса и повторного
      // watchRun это уже ДРУГОЙ ран той же метки. Без этой проверки событие старой сессии
      // доехало бы followUp'ом в transcript новой — ровно то, что сброс и должен предотвращать.
      if (watched.get(runId) !== entry) continue;
      const state = snap.state;
      if (state === "need_input") {
        const at = entry.announcedAt.get("need_input");
        // Первый анонс или напоминание. Напоминаем только пока доставка НЕ подтверждена:
        // доставленный вопрос уже в контексте директора, повтор был бы шумом. Закрытие
        // вопроса — ТОЛЬКО успешный dsh_answer (unwatchRun) либо смена состояния (dsh_kill →
        // ветка error ниже, ключи анонсов разные); ack от dsh_wait отодвигает напоминание.
        // Текст повтора дословно тот же — модель дедуплицирует смыслом.
        const stale = at !== undefined && Date.now() - at >= NEED_INPUT_REANNOUNCE_MS;
        const mayRepeat = !entry.delivered.has("need_input") && !attemptsExhausted(entry, "need_input");
        if (at === undefined || (stale && mayRepeat)) {
          const question = extractQuestion(snap.envelope);
          const text = `${entry.label} asks: ${question}\n(reply: dsh_answer runId=${runId})`;
          announce(runId, entry, "need_input", text);
        }
      } else if (state === "completed" && !entry.announcedAt.has("completed")) {
        const text = `${entry.label} finished: ${formatCompleted(snap.envelope)}`;
        if (announce(runId, entry, "completed", text)) {
          entry.terminal = { key: "completed", text };
        }
      } else if (state === "error" && !entry.announcedAt.has("error")) {
        // killed и timeout — это status:'error' c error.code, не отдельные state (stateOfEnvelope).
        const code = (snap.envelope as { error?: { code?: string } } | null | undefined)?.error?.code;
        let msg: string;
        if (code === "killed") {
          msg = `${entry.label} killed`;
        } else {
          msg = `${entry.label} failed: ${errorPrefix(snap.envelope, "dsh run failed")}`;
          const mLine = modelLine(snap.envelope);
          if (mLine) msg = `${msg}\n${mLine}`;
          const sLine = sessionLine(snap.envelope);
          if (sLine) msg = `${msg}\n${sLine}`;
        }
        if (announce(runId, entry, "error", msg)) {
          entry.terminal = { key: "error", text: msg };
        }
      }
    }
    stopPumpIfEmpty();
  } finally {
    ticking = false;
  }
}

// Test seams
export function __tickForTest(): Promise<void> {
  return tick();
}

export function __resetForTest(): void {
  // Тот же сброс, что и на смене сессии (карты меток живут дольше watched — см. комментарий у
  // них, — поэтому между тестами протекали бы: label прошлого теста продолжал резолвиться в
  // следующем и мог зазеленить регрессию на остаточном состоянии). Плюс ticking: реентерабельный
  // guard тика — сугубо внутрипроцессный, в production его сбрасывает finally самого тика.
  // Состояние квитанций (announcedText/attempts/delivered) живёт внутри записей watched и
  // уходит вместе с ними.
  resetForSessionSwitch();
  ticking = false;
}

export function __hasTimerForTest(): boolean {
  return timer !== undefined;
}

export function __setLastRenewedAtForTest(runId: string, ts: number): void {
  const e = watched.get(runId);
  if (e) e.lastRenewedAt = ts;
}

/** Сдвиг времени анонса для тестов повторов — по образцу __setLastRenewedAtForTest. */
export function __setAnnouncedAtForTest(runId: string, key: string, ts: number): void {
  const e = watched.get(runId);
  if (e) e.announcedAt.set(key, ts);
}

export function __watchedForTest(): Map<string, WatchedEntry> {
  return watched;
}
