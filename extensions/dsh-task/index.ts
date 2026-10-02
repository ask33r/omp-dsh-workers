import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
// Theme живёт в pi-coding-agent (modes/theme), а не в pi-tui: у pi-tui только
// частные темы отдельных компонентов (SymbolTheme, MarkdownTheme и т.п.).
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
  runDsh,
  startDsh,
  waitRun,
  killRun,
  readRunOutput,
  listRuns,
  sendToRun,
  sweepRuns,
  sessionIdOfRun,
  parseModelSpec,
  formatModelSpec,
  ModelSpecError,
  ownRunIds,
} from "../../tools/dsh-bridge/src/index.js";
import type { Envelope, RunEntry } from "../../tools/dsh-bridge/src/index.js";
import { resolveRoleModel } from "./role-model.ts";
import { registerDvibe } from "./dvibe.ts";
import {
  installRunsBoard,
  rememberRunsCtx,
  recordSteer,
  formatElapsed,
  shortId,
  rememberRunLabel,
  labelOf,
} from "./ui.ts";
import {
  rememberPi,
  watchRun,
  resolveLabel,
  resolveLabelForRun,
  resetForSessionSwitch,
  noteMessageDelivered,
  unwatchRun,
  acknowledgeRun,
} from "./relay.ts";

function themeIcon(theme: unknown, key: string, color: string, fallback: string): string {
  const t = theme as unknown as { styledSymbol?: (k: string, c: string) => string } | null | undefined;
  if (t && typeof t.styledSymbol === "function") {
    try {
      return t.styledSymbol(key, color as never);
    } catch {
      return fallback;
    }
  }
  return fallback;
}
function themeFg(theme: unknown, color: string, txt: string): string {
  const t = theme as unknown as { fg?: (c: string, s: string) => string } | null | undefined;
  if (t && typeof t.fg === "function") {
    try {
      return t.fg(color as never, txt);
    } catch {
      return txt;
    }
  }
  return txt;
}
function themeFgDim(theme: unknown, txt: string): string {
  return themeFg(theme, "dim", txt);
}
function themeSepDot(theme: unknown): string {
  const t = theme as unknown as { sep?: { dot?: string } } | null | undefined;
  return t?.sep?.dot ?? " · ";
}
function themeTreeLast(theme: unknown): string {
  const t = theme as unknown as { tree?: { last?: string } } | null | undefined;
  return t?.tree?.last ?? "└";
}
function themeTreeBranch(theme: unknown): string {
  const t = theme as unknown as { tree?: { branch?: string } } | null | undefined;
  return t?.tree?.branch ?? "├";
}
function themeSpinner(theme: unknown, frame?: number): string | undefined {
  const t = theme as unknown as { spinnerFrames?: string[] } | null | undefined;
  if (
    typeof frame === "number" &&
    Array.isArray(t?.spinnerFrames) &&
    (t as { spinnerFrames: string[] }).spinnerFrames.length > 0
  ) {
    const frames = (t as { spinnerFrames: string[] }).spinnerFrames;
    return frames[frame % frames.length];
  }
  return undefined;
}
type ModelSpec = { provider: string; model: string; reasoningEffort?: string };

// --- Неблокирующий API bridge-core (контракт v2, docs/contracts/dsh-bridge-async-v2.md).
// Реализация startDsh/waitRun/killRun/readRunOutput пишется параллельно в tools/dsh-bridge/;
// index.d.ts там ещё не обновлён под неё, поэтому типы держим локально, по контракту.
// need_input — терминальное состояние: ран закончился вопросом, а не результатом.
type RunState = "running" | "completed" | "need_input" | "error";

/**
 * Трёхзначный статус доставки (контракт v2, P1 п.4, раунд 2 кросс-ревью):
 * "delivered" — раннер подтвердил чтение; "pending" — сообщение легло в
 * канал, ран был жив при повторной проверке, но подтверждения чтения нет и
 * гарантии доставки нет — НЕ повод дублировать тем же или другим способом
 * (двойной steering — риск, сообщение с высокой вероятностью и так будет
 * прочитано); "undeliverable" — ран в терминальном состоянии, доставки уже
 * не будет, сообщение потеряно.
 */
type SendToRunStatus = "delivered" | "pending" | "undeliverable";

interface SendToRunResult {
  /** true только когда status === "delivered". Оставлено для совместимости. */
  delivered: boolean;
  status: SendToRunStatus;
  steerFile: string;
  pendingBytes: number;
  /** Сколько bridge реально прождал подтверждения чтения (мс), см. sendToRun. */
  waitedMs: number;
}

interface RunHandle {
  runId: string;
  pid: number;
  pgid: number;
  logFile: string;
  startedAt: string;
}

interface WaitPollResult {
  runId: string;
  state: RunState;
  envelope: Envelope | null;
  exitCode: number | null;
}

interface KillResult {
  runId: string;
  killed: boolean;
  state: RunState;
}

interface ReadOutputResult {
  chunk: string;
  nextOffset: number;
  eof: boolean;
}

// --- Параметры тулов: ровно то, что описано в pi.zod-схемах ниже. Явные типы нужны,
// потому что registerTool типизирован под TypeBox и Zod-схему в вывод не отдаёт
// (см. registerTypedTool).
type DshTaskParams = {
  task: string;
  resumeSessionId?: string;
  resumeFromRunId?: string;
  timeoutMs?: number;
  model?: string;
};
type DshSpawnParams = {
  task: string;
  resumeSessionId?: string;
  resumeFromRunId?: string;
  timeoutMs?: number;
  label?: string;
  model?: string;
};
type DshWaitParams = { runId: string; waitMs?: number };
type DshKillParams = { runId: string };
type DshSendParams = { runId: string; text: string };
type DshAnswerParams = { runId?: string; label?: string; answer: string };
type DshListParams = Record<string, never>;

/**
 * details у промежуточных апдейтов dsh_task — не Envelope: ран ещё не завершён,
 * наружу идёт только превью прочитанного stdout.
 */
type StreamingPreview = { streaming: true; preview: string };
type DshTaskDetails = Envelope | StreamingPreview;
/**
 * dsh_wait кладёт в details либо сам envelope (ран завершился), либо снимок
 * состояния, либо превью стрима — renderResult ниже разбирает все три формы.
 */
type DshWaitSnapshot = {
  runId: string;
  state: string;
  envelope: Envelope | null;
  exitCode: number | null;
  cancelled?: boolean;
};
type DshWaitDetails = Envelope | DshWaitSnapshot | (StreamingPreview & { runId: string });
type DshAnswerDetails = { runId?: string; resumedFrom?: string; newRunId?: string; label?: string | null };
type DshListDetails = { runs: Array<RunEntry & { runId: string }> };

/** Envelope ли это (а не превью стрима). */
function isEnvelope(details: DshTaskDetails | undefined): details is Envelope {
  return details !== undefined && "status" in details;
}

/**
 * Регистрация тула с сохранением типов параметров и details.
 *
 * `ExtensionAPI.registerTool` объявлен как `registerTool<TParams extends TSchema>`
 * (TypeBox), а схему параметров мы описываем через `pi.zod` — вывод падает на дефолт
 * `TSchema`, у которого `Static<TSchema>` вырождается в `unknown`, и любой точный тип
 * params/args в наших обработчиках перестаёт совпадать с сигнатурой чужого API.
 * Обёртка держит обработчики типизированными, а расхождение схем гасит ровно в одном
 * месте — на границе с API. Значения params к моменту вызова execute уже провалидированы
 * самим OMP по переданной схеме, так что у приведения есть рантайм-гарантия.
 */
type TypedToolDefinition<TParams, TDetails> = Omit<
  ToolDefinition,
  "parameters" | "execute" | "renderCall" | "renderResult"
> & {
  parameters: unknown;
  /**
   * Схлопывает карточку вызова и результата в одну строку UI. Опцию читает рендерер
   * OMP (так её объявляют встроенные тулы — task/index.d.ts, lsp/render.d.ts), но в
   * публичном `ToolDefinition` для расширений её нет, поэтому объявляем здесь.
   */
  mergeCallAndResult?: boolean;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?: (args: TParams, options: ToolRenderResultOptions, theme: Theme) => Component;
  renderResult?: (
    result: AgentToolResult<TDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    args?: TParams,
  ) => Component;
};

function registerTypedTool<TParams, TDetails>(pi: ExtensionAPI, def: TypedToolDefinition<TParams, TDetails>): void {
  pi.registerTool(def as unknown as ToolDefinition);
}

/**
 * Первый текстовый блок результата тула. `AgentToolResult.content` допускает и
 * картинки (ImageContent), у которых поля `text` нет вовсе.
 */
function firstText(result: AgentToolResult<unknown>): string {
  const head = result.content?.[0];
  if (head === undefined || !("text" in head)) return "";
  return typeof head.text === "string" ? head.text : "";
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function modelLine(envelope: unknown): string {
  const m = (envelope as { model?: ModelSpec } | null | undefined)?.model;
  if (!m) return "";
  return `model: ${formatModelSpec(m)}`;
}

export function sessionLine(envelope: unknown): string {
  const sid = (envelope as { sessionId?: string | null } | null | undefined)?.sessionId;
  if (typeof sid !== "string" || sid.length === 0) return "";
  return `session: ${sid}`;
}

export function errorPrefix(envelope: unknown, fallback: string): string {
  const err = (envelope as { error?: { code?: string; message?: string } } | null | undefined)?.error;
  const code = typeof err?.code === "string" && err.code.length > 0 ? err.code : "";
  const msg = typeof err?.message === "string" && err.message.length > 0 ? err.message : fallback;
  return code ? `error [${code}]: ${msg}` : `error: ${msg}`;
}

export function extractQuestion(envelope: unknown): string {
  const q = (envelope as { question?: unknown } | null | undefined)?.question;
  return typeof q === "string" ? q : "";
}

/**
 * Сторож брошенных ранов.
 *
 * DSH стартует detached, поэтому смерть OMP-сессии до него не доходит, а
 * внутренний таймаут рана живёт в памяти процесса и умирает вместе с ним. Без периодической зачистки осиротевший ран продолжает работать
 * и жечь токены, пока его никто не ждёт.
 *
 * Подметание при загрузке забирает то, что пережило предыдущую сессию OMP;
 * заодно из реестра уходят записи уже завершённых ранов (результат остаётся в
 * envelope-файле, поэтому читатель ничего не теряет).
 */
const REAP_INTERVAL_MS = 30_000;
export const SESSION_SHUTDOWN_KILL_CAP_MS = 5000;
let sessionShutdownKillCapMs = SESSION_SHUTDOWN_KILL_CAP_MS;
/** Только для тестов: ужать кап ожидания kill на session_shutdown. */
export function setSessionShutdownKillCapForTest(ms: number): void {
  sessionShutdownKillCapMs = ms;
}
let watchdogStarted = false;

function startOrphanWatchdog(): void {
  if (watchdogStarted) return;
  // Мок bridge в юнит-тестах этой функции не отдаёт — сторож там просто не нужен.
  if (typeof sweepRuns !== "function") return;
  watchdogStarted = true;

  const sweep = (): void => {
    // Зачистка вспомогательная: её отказ не должен ронять сессию OMP.
    void Promise.resolve()
      .then(() => sweepRuns())
      .catch(() => {});
  };

  sweep();
  const timer: unknown = setInterval(sweep, REAP_INTERVAL_MS);
  // Сторож не повод держать процесс живым.
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}
export default function dshTaskExtension(pi: ExtensionAPI): void {
  rememberPi(pi);
  startOrphanWatchdog();
  // Штатный выход сессии OMP: убиваем раны, запущенные этим процессом
  // (bridge activeRuns). Чужие сессии — только реестр, остаются на сторожа.
  // killRun шлёт SIGTERM синхронно до первого await (см. async-run.js:killRun),
  // значит сигнал уходит даже если хук не дожидаются; эскалация до SIGKILL
  // через ~2с — best effort. OMP await'ит session_shutdown с лимитом
  // SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS=2000 (см. runner.d.ts), поэтому здесь
  // свой кап 5000мс поверх — но OMP всё равно обрежет ожидание на 2с; важно,
  // что SIGTERM уже ушёл синхронно. Реестр и envelope-файлы не чистим —
  // они нужны dsh_list следующей сессии для диагностики. Крэш — на сторожа.
  if (typeof ownRunIds === "function") {
    pi.on("session_shutdown", async () => {
      const ids = ownRunIds();
      if (ids.length === 0) return;
      // Один таймер — он же кап гонки: unref, чтобы не держать выход процесса,
      // clearTimeout в finally, чтобы после быстрого kill он не висел до капа.
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(ids.map((id) => killRun(id))),
          new Promise<void>((resolve) => {
            capTimer = setTimeout(resolve, sessionShutdownKillCapMs);
            if (typeof (capTimer as unknown as { unref?: () => unknown }).unref === "function") {
              (capTimer as unknown as { unref: () => unknown }).unref();
            }
          }),
        ]);
      } catch {
        // выход не должен падать из-за уборки
      } finally {
        if (capTimer !== undefined) clearTimeout(capTimer);
      }
    });
  }
  // Смена сессии БЕЗ перезапуска процесса (`/new`, resume, fork, branch): состояние relay
  // модульное, поэтому его надо сбросить — иначе событие рана СТАРОЙ сессии уедет followUp'ом
  // в transcript НОВОЙ, а резолв метки отдаст там ран из прошлой сессии.
  //
  // Вешаемся на ПОСЛЕ-события (session_switch/session_branch), а не на session_before_switch:
  // before_*-события отменяемы (SessionBeforeSwitchResult.cancel, shared-events.ts:348) — сброс
  // там при отменённом переключении молча оставил бы живые раны без relay до конца сессии.
  // После-события приходят ровно тогда, когда transcript действительно сменился; сам OMP
  // рехидратирует свои подсистемы на этой же паре (autoresearch/index.ts:249-250,
  // modes/warp-events.ts:177-178). Раны при этом НЕ убиваем — обоснование в resetForSessionSwitch.
  pi.on("session_switch", async () => {
    resetForSessionSwitch();
  });
  pi.on("session_branch", async () => {
    resetForSessionSwitch();
  });
  // Квитанция доставки для relay (П.B/П.H): у ExtensionAPI нет прямой квитанции
  // (sendMessage → void), но входящие сообщения агент-цикл эмитит перед вызовом модели —
  // message_start с нашим payload и есть доказательство, что followUp лёг в контекст хода.
  // До раунда 3 здесь был счётчик before_agent_start; он не срабатывал вовсе, когда followUp
  // вливался в уже работающий цикл, и прочитанный результат повторялся каждые 120 с.
  pi.on("message_start", async (event) => {
    noteMessageDelivered((event as unknown as { message?: unknown }).message);
  });
  // Слэш-команда /dvibe: переключает эту же сессию в режим директора и обратно.
  registerDvibe(pi);
  installRunsBoard(pi);

  registerTypedTool<DshTaskParams, DshTaskDetails>(pi, {
    name: "dsh_task",
    label: "DSH task",
    description:
      "Run a task via DSH bridge (dsh --profile headless). Streams stdout. One-shot: a dsh_task run leaves no envelope on disk, so it cannot itself be continued later — chains of turns go through dsh_spawn.",
    parameters: pi.zod.object({
      task: pi.zod.string().min(1).describe("Task brief (written to temp file)"),
      resumeSessionId: pi.zod
        .string()
        .optional()
        .describe("Resume an existing DSH session by its sessionId (from the envelope, looks like session-<uuid>)"),
      resumeFromRunId: pi.zod
        .string()
        .optional()
        .describe(
          "Continue the DSH session of a previous dsh_spawn run — pass that run's runId; its sessionId is looked up for you. Prefer this over resumeSessionId.",
        ),
      timeoutMs: pi.zod.number().int().positive().optional().describe("Timeout ms"),
      model: pi.zod
        .string()
        .optional()
        .describe(
          "DSH executor model in <provider>/<model>[:<effort>] notation, e.g. myprovider/my-model:high; if omitted — the @dsh role's model from OMP; if that role does not resolve — your current session's model; if neither resolves — DSH's own default; not inherited on resume",
        ),
    }),

    async execute(
      _toolCallId: string,
      params: DshTaskParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<DshTaskDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      // Парс модели до создания temp — невалидная строка не должна создавать ран/файл (хэндофф п.1)
      let parsedModel: ModelSpec | undefined;
      if (params.model !== undefined) {
        try {
          parsedModel = parseModelSpec(params.model as string) as ModelSpec;
        } catch (err: unknown) {
          if (err instanceof ModelSpecError) {
            return {
              content: [{ type: "text", text: `error [invalid_model]: ${err.message}` }],
              details: {
                v: 1 as const,
                runId: "",
                sessionId: null,
                status: "error" as const,
                error: { code: "invalid_model", message: err.message },
              },
              isError: true,
            };
          }
          throw err;
        }
      }
      // Без явной модели в брифе исполнитель наследует роль @dsh из OMP (см. role-model.ts).
      const model = parsedModel ?? resolveRoleModel(ctx);
      const cwd: string = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const dir = await mkdtemp(join(tmpdir(), "dsh-task-"));
      const taskFile = join(dir, "task.md");
      await writeFile(taskFile, params.task, "utf8");

      let buffer = "";
      let pendingLines: string[] = [];
      let lastEmit = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const flush = (): void => {
        if (!onUpdate || pendingLines.length === 0) return;
        const text = pendingLines.join("\n");
        pendingLines = [];
        lastEmit = Date.now();
        onUpdate({
          content: [{ type: "text", text }],
          details: { streaming: true, preview: truncate(oneLine(text), 2000) },
        });
      };

      const scheduleFlush = (): void => {
        if (!onUpdate) return;
        const now = Date.now();
        const elapsed = now - lastEmit;
        if (elapsed >= 500) {
          flush();
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = undefined;
            flush();
          }, 500 - elapsed);
        }
      };

      const onStdout = (chunk: string): void => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          pendingLines.push(line);
          scheduleFlush();
          idx = buffer.indexOf("\n");
        }
      };

      try {
        // Перевод runId → sessionId делается здесь, на слое тула: runDsh — это
        // замороженный контракт v1 и принимает только resumeSessionId.
        let resumeSessionId = params.resumeSessionId;
        if (!resumeSessionId && params.resumeFromRunId) {
          const found = await sessionIdOfRun(params.resumeFromRunId);
          if (!found) {
            throw new Error(
              `run ${params.resumeFromRunId} has no session to resume (not finished, not a dsh_spawn run, or already swept)`,
            );
          }
          resumeSessionId = found;
        }
        const envelope: Envelope = await runDsh({
          taskFile,
          resumeSessionId,
          cwd,
          timeoutMs: params.timeoutMs,
          model,
          // Директор отвечает на вопросы рана через dsh_answer, поэтому просим
          // DSH помечать их маркером need_input.
          askProtocol: true,
          onStdout,
          signal,
        });

        clearTimeout(timer);
        timer = undefined;
        if (buffer.length > 0) {
          pendingLines.push(buffer);
          buffer = "";
        }
        if (onUpdate && pendingLines.length > 0) {
          flush();
        }

        if (envelope.status === "completed") {
          let text = envelope.result ?? "";
          const line = modelLine(envelope);
          if (line) text = text ? `${text}\n${line}` : line;
          const sline = sessionLine(envelope);
          if (sline) text = text ? `${text}\n${sline}` : sline;
          return {
            content: [{ type: "text", text }],
            details: envelope,
          };
        }
        if (envelope.status === "need_input") {
          let text = envelope.question ?? "";
          const line = modelLine(envelope);
          if (line) text = text ? `${text}\n${line}` : line;
          const sline = sessionLine(envelope);
          if (sline) text = text ? `${text}\n${sline}` : sline;
          return {
            content: [{ type: "text", text }],
            details: envelope,
          };
        }
        {
          const errTextBase = errorPrefix(envelope, "dsh_task failed");
          let errText = errTextBase;
          const line = modelLine(envelope);
          if (line) errText = `${errText}\n${line}`;
          const sline = sessionLine(envelope);
          if (sline) errText = `${errText}\n${sline}`;
          return {
            content: [{ type: "text", text: errText }],
            details: envelope,
            isError: true,
          };
        }
      } catch (err: unknown) {
        clearTimeout(timer);
        const aborted = signal?.aborted || (err instanceof Error && err.name === "AbortError");
        if (aborted) {
          return {
            content: [{ type: "text", text: "cancelled" }],
            details: {
              v: 1 as const,
              runId: "",
              sessionId: null,
              status: "error" as const,
              error: { code: "killed", message: "cancelled" },
            },
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: {
            v: 1 as const,
            runId: "",
            sessionId: null,
            status: "error" as const,
            error: { code: "killed", message },
          },
          isError: true,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    renderCall(args: DshTaskParams, _options: ToolRenderResultOptions, _theme: Theme): Text {
      const preview = truncate(oneLine(args.task ?? ""), 80);
      return new Text(`dsh ▶ ${preview}`, 0, 0);
    },

    renderResult(result: AgentToolResult<DshTaskDetails>, _options: ToolRenderResultOptions, _theme: Theme): Text {
      const env = isEnvelope(result.details) ? result.details : undefined;
      const text: string = firstText(result);
      const status = env?.status ?? (result.isError ? "error" : "completed");
      const truncated = truncate(oneLine(text), 400);
      const out = `[${status}] ${truncated}${env ? " (see details)" : ""}`;
      return new Text(out, 0, 0);
    },
  });

  // --- Тулы оркестрации (контракт v2): dsh_spawn / dsh_wait / dsh_kill / dsh_list ---
  // Offset/буфер незавершённой строки живут между отдельными dsh_wait-вызовами одной
  // сессии (замыкание над dshTaskExtension), чтобы стрим не терял и не дублировал байты.
  const waitOffsets = new Map<string, number>();
  const waitBuffers = new Map<string, string>();
  const WAIT_DEFAULT_MS = 30000;
  const WAIT_POLL_STEP_MS = 500;

  registerTypedTool<DshSpawnParams, RunHandle & { label?: string | null }>(pi, {
    name: "dsh_spawn",
    label: "DSH spawn",
    mergeCallAndResult: true,
    description:
      "Start a DSH bridge run in the background and return immediately, without waiting for it to finish. Use dsh_wait to poll/await it and dsh_kill to stop it.",
    parameters: pi.zod.object({
      task: pi.zod.string().min(1).describe("Task brief (written to temp file)"),
      resumeSessionId: pi.zod
        .string()
        .optional()
        .describe("Resume an existing DSH session by its sessionId (from the envelope, looks like session-<uuid>)"),
      resumeFromRunId: pi.zod
        .string()
        .optional()
        .describe(
          "Continue the DSH session of a previous run — pass that run's runId; the bridge looks its sessionId up itself. Prefer this over resumeSessionId.",
        ),
      timeoutMs: pi.zod.number().int().positive().optional().describe("Run timeout ms (guarded by the bridge itself)"),
      label: pi.zod
        .string()
        .optional()
        .describe("Short run label for cross-agent lookup in dsh_list (e.g. worker name)"),
      model: pi.zod
        .string()
        .optional()
        .describe(
          "DSH executor model in <provider>/<model>[:<effort>] notation, e.g. myprovider/my-model:high; if omitted — the @dsh role's model from OMP; if that role does not resolve — your current session's model; if neither resolves — DSH's own default; not inherited on resume",
        ),
    }),

    async execute(
      _toolCallId: string,
      params: DshSpawnParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<RunHandle & { label?: string | null }> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      let parsedModel: ModelSpec | undefined;
      if (params.model !== undefined) {
        try {
          parsedModel = parseModelSpec(params.model as string) as ModelSpec;
        } catch (err: unknown) {
          if (err instanceof ModelSpecError) {
            return {
              content: [{ type: "text", text: `error [invalid_model]: ${(err as Error).message}` }],
              details: { runId: "", pid: 0, pgid: 0, logFile: "", startedAt: "" },
              isError: true,
            };
          }
          throw err;
        }
      }
      // Без явной модели в брифе исполнитель наследует роль @dsh из OMP (см. role-model.ts).
      const model = parsedModel ?? resolveRoleModel(ctx);
      const cwd: string = ctx?.cwd ?? process.cwd();
      const dir = await mkdtemp(join(tmpdir(), "dsh-spawn-"));
      const taskFile = join(dir, "task.md");
      await writeFile(taskFile, params.task, "utf8");

      try {
        // startDsh reads taskFile fully before spawning (как в v1/runDsh), поэтому temp-dir
        // безопасно удалить сразу после резолва промиса — контент уже в argv дочернего процесса.
        const handle: RunHandle = await startDsh({
          taskFile,
          resumeSessionId: params.resumeSessionId,
          resumeFromRunId: params.resumeFromRunId,
          cwd,
          timeoutMs: params.timeoutMs,
          model,
          // Директор отвечает на вопросы рана через dsh_answer, поэтому просим
          // DSH помечать их маркером need_input.
          askProtocol: true,
          label: params.label,
          // Lean-воркер: если окружение omp-сессии задаёт DSH_WORKER_PATCH,
          // мост подставит --patch <path> спавну (persona + минимум плагинов).
          env: { ...process.env } as Record<string, string>,
        });
        if (
          typeof handle.runId === "string" &&
          handle.runId.length > 0 &&
          typeof params.label === "string" &&
          params.label.length > 0
        ) {
          rememberRunLabel(handle.runId, params.label);
        } else if (typeof handle.runId === "string" && handle.runId.length > 0) {
          const maybeLabel = (handle as unknown as { label?: string | null }).label;
          if (typeof maybeLabel === "string" && maybeLabel.length > 0) rememberRunLabel(handle.runId, maybeLabel);
        }
        // Relay: только раны, начатые этой сессией, порождают сообщения в чат директора.
        if (typeof handle.runId === "string" && handle.runId.length > 0) {
          const relayLabel =
            typeof params.label === "string" && params.label.length > 0 ? params.label : shortId(handle.runId);
          watchRun(handle.runId, relayLabel);
        }
        const labelSuffix = params.label ? ` label=${params.label}` : "";
        const modelSuffix = model ? ` model=${formatModelSpec(model)}` : "";
        return {
          content: [{ type: "text", text: `started ${handle.runId} (pid ${handle.pid})${labelSuffix}${modelSuffix}` }],
          details: handle,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: { runId: "", pid: 0, pgid: 0, logFile: "", startedAt: "" },
          isError: true,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    renderCall(args: DshSpawnParams, options: ToolRenderResultOptions, theme: Theme): Text {
      const isRunning = Boolean(options.isPartial);
      const icon =
        isRunning && options.spinnerFrame !== undefined
          ? (themeSpinner(theme, options.spinnerFrame) ?? themeIcon(theme, "status.running", "accent", "●"))
          : themeIcon(theme, "status.pending", "muted", "●");
      const raw =
        typeof args.label === "string" && args.label.length > 0
          ? args.label
          : shortId(typeof args.label === "string" ? args.label : "");
      // Use label if present, otherwise ellipsis (spec: label else runId8 concept — runId unknown at call time)
      const label = typeof args.label === "string" && args.label.length > 0 ? args.label : "…";
      const title = themeFg(theme, "accent", `dsh spawn: ${label}`);
      const preview = truncate(oneLine(args.task ?? ""), 80);
      const previewLine = ` ${themeFgDim(theme, themeTreeLast(theme))} ${themeFgDim(theme, preview)}`;
      const hasModel = typeof args.model === "string" && args.model.length > 0;
      const dot = themeSepDot(theme);
      const meta = hasModel ? themeFgDim(theme, truncate(args.model as string, 30)) : "";
      const header = meta ? `${icon} ${title} ${meta}` : `${icon} ${title}`;
      void raw;
      void dot;
      return new Text(`${header}\n${previewLine}`, 0, 0);
    },

    renderResult(
      result: AgentToolResult<RunHandle & { label?: string | null }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
      args?: DshSpawnParams,
    ): Text {
      const isError = Boolean(result.isError);
      if (isError) {
        const txt: string = firstText(result);
        const msg = truncate(oneLine(txt), 300);
        const icon = themeIcon(theme, "status.error", "error", "✗");
        const title = themeFg(
          theme,
          "accent",
          `dsh spawn: ${typeof args?.label === "string" && args.label.length > 0 ? args.label : "…"}`,
        );
        return new Text(
          `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", msg)}`,
          0,
          0,
        );
      }
      const d = result.details as unknown as { runId?: string; pid?: number; label?: string | null } | undefined;
      const labelFromDetails =
        typeof d?.label === "string" && (d.label as string).length > 0 ? (d.label as string) : undefined;
      const labelFromArgs =
        typeof args?.label === "string" && (args.label as string).length > 0 ? (args.label as string) : undefined;
      const label = labelFromDetails ?? labelFromArgs ?? "…";
      const runId = typeof d?.runId === "string" ? d.runId : "";
      const runId8 = shortId(runId);
      const pid = d?.pid;
      const icon = themeIcon(theme, "status.done", "success", "✓");
      const title = themeFg(theme, "accent", `dsh spawn: ${label}`);
      const hasLabel = label !== "…" && label.length > 0;
      const metaParts: string[] = [];
      if (typeof pid === "number") metaParts.push(`pid ${pid}`);
      if (hasLabel && runId8) metaParts.push(runId8);
      else if (!hasLabel && runId8) {
        // When no label, title already is runId8 concept; don't duplicate
      }
      const meta = metaParts.length > 0 ? themeFgDim(theme, metaParts.join(themeSepDot(theme))) : "";
      const header = meta ? `${icon} ${title} ${meta}` : `${icon} ${title}`;
      return new Text(header, 0, 0);
    },
  });

  registerTypedTool<DshWaitParams, DshWaitDetails>(pi, {
    name: "dsh_wait",
    label: "DSH wait",
    mergeCallAndResult: true,
    description:
      "Wait for a run started by dsh_spawn, up to waitMs (default 30000ms). Timing out is a normal outcome, not an error: the run stays alive and can be waited on again. Aborting cancels only this wait, never the run — use dsh_kill to actually stop it.",
    parameters: pi.zod.object({
      runId: pi.zod.string().min(1).describe("Run id returned by dsh_spawn"),
      waitMs: pi.zod
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Max time to wait, ms (default 30000; 0 = single poll)"),
    }),

    async execute(
      _toolCallId: string,
      params: DshWaitParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<DshWaitDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      const { runId } = params;
      const waitMs = params.waitMs ?? WAIT_DEFAULT_MS;

      let offset = waitOffsets.get(runId) ?? 0;
      let buf = waitBuffers.get(runId) ?? "";
      let pendingLines: string[] = [];
      let lastEmit = 0;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;

      const flushPending = (): void => {
        if (!onUpdate || pendingLines.length === 0) return;
        const text = pendingLines.join("\n");
        pendingLines = [];
        lastEmit = Date.now();
        onUpdate({
          content: [{ type: "text", text }],
          details: { streaming: true, runId, preview: truncate(oneLine(text), 2000) },
        });
      };

      const scheduleFlush = (): void => {
        if (!onUpdate) return;
        const now = Date.now();
        const elapsed = now - lastEmit;
        if (elapsed >= 500) {
          flushPending();
        } else if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            flushPending();
          }, 500 - elapsed);
        }
      };

      // Забирает весь новый вывод, доступный прямо сейчас, от сохранённого offset.
      const pull = async (): Promise<void> => {
        for (;;) {
          const out: ReadOutputResult = await readRunOutput(runId, { offset });
          offset = out.nextOffset;
          if (out.chunk) {
            buf += out.chunk;
            let idx = buf.indexOf("\n");
            while (idx !== -1) {
              pendingLines.push(buf.slice(0, idx));
              buf = buf.slice(idx + 1);
              idx = buf.indexOf("\n");
            }
            scheduleFlush();
          }
          if (out.eof || !out.chunk) break;
        }
      };

      let last: WaitPollResult = { runId, state: "running", envelope: null, exitCode: null };
      let waitCancelled = false;

      try {
        const deadline = Date.now() + Math.max(0, waitMs);
        do {
          if (signal?.aborted) {
            waitCancelled = true;
            break;
          }
          const remaining = deadline - Date.now();
          const step = Math.max(0, Math.min(WAIT_POLL_STEP_MS, remaining));
          last = await waitRun(runId, { waitMs: step, signal });
          await pull();
          if (last.state !== "running") break;
          if (signal?.aborted) {
            waitCancelled = true;
            break;
          }
        } while (Date.now() < deadline);
      } catch (err: unknown) {
        clearTimeout(flushTimer);
        if (signal?.aborted) {
          waitCancelled = true;
        } else {
          waitOffsets.set(runId, offset);
          waitBuffers.set(runId, buf);
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `error: ${message}` }],
            details: { runId, state: "error", envelope: null, exitCode: null },
            isError: true,
          };
        }
      }

      clearTimeout(flushTimer);
      flushTimer = undefined;

      // Только когда ран реально завершился — считаем незакрытую строку финальной и флашим её.
      // Иначе (таймаут/abort) буфер и offset сохраняются для следующего dsh_wait без потерь/дублей.
      const finished = last.state !== "running" && !waitCancelled;
      if (finished && buf.length > 0) {
        pendingLines.push(buf);
        buf = "";
      }
      flushPending();

      if (finished) {
        waitOffsets.delete(runId);
        waitBuffers.delete(runId);
      } else {
        waitOffsets.set(runId, offset);
        waitBuffers.set(runId, buf);
      }

      if (waitCancelled) {
        return {
          content: [{ type: "text", text: `wait cancelled for ${runId}; run still active` }],
          details: { runId, state: last.state, envelope: last.envelope, exitCode: last.exitCode, cancelled: true },
        };
      }

      if (last.state === "running") {
        return {
          content: [{ type: "text", text: `still running: ${runId}` }],
          details: { runId, state: "running", envelope: null, exitCode: null },
        };
      }

      const envelope = last.envelope;
      if (!envelope) {
        return {
          content: [{ type: "text", text: `run ${runId} finished with no envelope (state ${last.state})` }],
          details: { runId, state: last.state, envelope: null, exitCode: last.exitCode },
          isError: last.state === "error",
        };
      }
      // П.F: директор получил envelope синхронно — гасим авто-доставку relay по этому рану,
      // иначе он принёс бы то же самое ещё раз followUp'ом (со страховкой П.B — гарантированно).
      // Зеркало acknowledgeDeliveries родного vibe mode (vibe/runtime.ts: vibe_wait по
      // settled-джобам подавляет их авто-доставку). Терминальный ран снимается с наблюдения
      // молча, need_input остаётся (вопрос ждёт dsh_answer), но напоминание откладывается.
      // При таймауте ожидания (state=running) и отменённом wait сюда не попадаем — ack только
      // за реально возвращённый envelope. dsh_list ack НЕ зовёт: список ≠ прочитанный результат.
      acknowledgeRun(runId, envelope.status);
      if (envelope.status === "completed") {
        let text = envelope.result ?? "";
        const line = modelLine(envelope);
        if (line) text = text ? `${text}\n${line}` : line;
        const sline = sessionLine(envelope);
        if (sline) text = text ? `${text}\n${sline}` : sline;
        return {
          content: [{ type: "text", text }],
          details: envelope,
        };
      }
      if (envelope.status === "need_input") {
        let text = envelope.question ?? "";
        const line = modelLine(envelope);
        if (line) text = text ? `${text}\n${line}` : line;
        const sline = sessionLine(envelope);
        if (sline) text = text ? `${text}\n${sline}` : sline;
        return {
          content: [{ type: "text", text }],
          details: envelope,
        };
      }
      {
        let errText = errorPrefix(envelope, "dsh run failed");
        const line = modelLine(envelope);
        if (line) errText = `${errText}\n${line}`;
        const sline = sessionLine(envelope);
        if (sline) errText = `${errText}\n${sline}`;
        return {
          content: [{ type: "text", text: errText }],
          details: envelope,
          isError: true,
        };
      }
    },

    renderCall(args: DshWaitParams, options: ToolRenderResultOptions, theme: Theme): Text {
      const runId = typeof args.runId === "string" ? args.runId : String(args.runId ?? "");
      const lab = labelOf(runId);
      const isLabeled = lab !== shortId(runId) && lab.length > 0;
      const display = lab || shortId(runId) || "…";
      const titleBase = `dsh wait: ${display}`;
      const icon =
        typeof options.spinnerFrame === "number"
          ? (themeSpinner(theme, options.spinnerFrame) ?? themeIcon(theme, "status.pending", "muted", "●"))
          : themeIcon(theme, "status.pending", "muted", "●");
      // Когда показана метка — runId8 уходит в meta, когда метки нет — только runId8 в заголовке без дубля
      const waitMs = typeof args.waitMs === "number" ? args.waitMs : WAIT_DEFAULT_MS;
      const elapsedStr = formatElapsed(new Date(Date.now() - waitMs).toISOString(), Date.now());
      const meta = isLabeled
        ? themeFgDim(theme, [elapsedStr, shortId(runId)].join(themeSepDot(theme)))
        : themeFgDim(theme, elapsedStr);
      void WAIT_DEFAULT_MS;
      const title = themeFg(theme, "accent", titleBase);
      return new Text(`${icon} ${title} ${meta}`, 0, 0);
    },

    renderResult(result: AgentToolResult<DshWaitDetails>, options: ToolRenderResultOptions, theme: Theme): Text {
      const d = result.details as
        | { state?: string; envelope?: Envelope | null; runId?: string; label?: string | null }
        | undefined;
      // На завершении dsh_wait кладёт в details сам envelope (`details: envelope`), на
      // running/error/cancel — обёртку {runId, state, envelope, exitCode}; принимаем обе формы.
      const bare = d as unknown as { v?: number; status?: string } | undefined;
      const envelopeOf =
        d?.envelope ??
        (typeof bare?.status === "string" && typeof bare?.v === "number" ? (d as unknown as Envelope) : undefined);
      const envStatus = (envelopeOf as unknown as { status?: string } | null | undefined)?.status;
      const state: string | undefined = typeof d?.state === "string" ? d.state : envStatus;
      const txt: string = firstText(result);
      const runIdForLabel =
        typeof d?.runId === "string"
          ? d.runId
          : typeof (envelopeOf as unknown as { runId?: string } | null | undefined)?.runId === "string"
            ? (envelopeOf as unknown as { runId: string }).runId
            : "";
      // Метка из памяти сессии (rememberRunLabel/dsh_list/dsh_spawn), иначе runId8
      const displayLabel = runIdForLabel
        ? labelOf(runIdForLabel)
        : shortId(
            runIdForLabel ||
              (typeof (envelopeOf as unknown as { runId?: string } | null | undefined)?.runId === "string"
                ? (envelopeOf as unknown as { runId: string }).runId
                : ""),
          );
      const titleBaseCore = `dsh wait: ${displayLabel || "…"}`;
      // Когда есть метка — runId8 позже добавится в meta заголовка, когда нет — остаётся в titleBaseCore
      const titleBase = titleBaseCore;
      if (state === "running") {
        const icon =
          typeof options.spinnerFrame === "number"
            ? (themeSpinner(theme, options.spinnerFrame) ?? themeIcon(theme, "status.running", "accent", "●"))
            : themeIcon(theme, "status.running", "accent", "●");
        const title = themeFg(theme, "accent", titleBase);
        // elapsed from content? use wait meta is not available here; use state meta
        // For running, spec says show elapsed in meta — approximate from details if available
        const header = `${icon} ${title}`;
        const lines = txt.split("\n").filter((l) => l.length > 0);
        const tail = lines.slice(-5);
        if (tail.length === 0) return new Text(header, 0, 0);
        const body = tail.map((l) => themeFg(theme, "toolOutput", l)).join("\n");
        return new Text(`${header}\n${body}`, 0, 0);
      }
      if (envelopeOf) {
        const env = envelopeOf as unknown as Envelope & {
          model?: { provider: string; model: string; reasoningEffort?: string };
          sessionId?: string | null;
          question?: string;
          error?: { code?: string; message?: string };
          result?: string;
          runId?: string;
        };
        if (env.status === "completed") {
          const modelRaw = env.model
            ? formatModelSpec(env.model as unknown as { provider: string; model: string; reasoningEffort?: string })
            : "default";
          const modelStr = modelRaw.length > 30 ? `${modelRaw.slice(0, 29)}…` : modelRaw;
          // id сессии вида session-<uuid>: префикс убираем, иначе первые 8 символов — это он сам
          const sess =
            typeof env.sessionId === "string" && env.sessionId.length > 0
              ? env.sessionId.replace(/^session-/, "").slice(0, 8)
              : "—";
          const bytes = Buffer.byteLength(env.result ?? txt, "utf8");
          const kb = `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
          const icon = themeIcon(theme, "status.done", "success", "✓");
          const title = themeFg(theme, "accent", titleBase);
          const meta = themeFgDim(theme, [modelStr, sess, kb].join(themeSepDot(theme)));
          const header = `${icon} ${title} ${meta}`;
          const lines = (env.result ?? txt).split("\n");
          const preview = lines.slice(0, 6);
          const remaining = lines.length - preview.length;
          const body = preview.map((l) => themeFg(theme, "toolOutput", l)).join("\n");
          const more = remaining > 0 ? `\n${themeFgDim(theme, `… ${remaining} more lines`)}` : "";
          return new Text(`${header}\n${body}${more}`, 0, 0);
        }
        if (env.status === "need_input") {
          const icon = themeIcon(theme, "status.warning", "warning", "❓");
          const title = themeFg(theme, "accent", titleBase);
          const meta = themeFgDim(theme, "needs input");
          const header = `${icon} ${title} ${meta}`;
          const qLines = (env.question ?? txt).split("\n").slice(0, 3);
          const body = qLines.map((l) => themeFg(theme, "toolOutput", l)).join("\n");
          return new Text(`${header}\n${body}`, 0, 0);
        }
        if (env.status === "error") {
          const icon = themeIcon(theme, "status.error", "error", "✗");
          const title = themeFg(theme, "accent", titleBase);
          const code = env.error?.code ? ` [${env.error.code}]` : "";
          const msg = env.error?.message ?? txt;
          const detail = `error${code}: ${msg}`;
          return new Text(
            `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", truncate(oneLine(detail), 300))}`,
            0,
            0,
          );
        }
      }
      if (state === "error" || result.isError) {
        const icon = themeIcon(theme, "status.error", "error", "✗");
        const title = themeFg(theme, "accent", titleBase);
        const code = (d?.envelope as unknown as { error?: { code?: string } } | null | undefined)?.error?.code;
        const codeStr = typeof code === "string" && code.length > 0 ? ` [${code}]` : "";
        const msg = truncate(oneLine(txt), 300);
        return new Text(
          `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", `error${codeStr}: ${msg}`)}`,
          0,
          0,
        );
      }
      // fallback
      const icon = themeIcon(theme, "status.done", "success", "✓");
      const title = themeFg(theme, "accent", titleBase);
      return new Text(`${icon} ${title} ${themeFgDim(theme, truncate(oneLine(txt), 200))}`, 0, 0);
    },
  });

  registerTypedTool<DshKillParams, KillResult & { label?: string | null }>(pi, {
    name: "dsh_kill",
    label: "DSH kill",
    mergeCallAndResult: true,
    description:
      "Kill any run in the registry by its id (SIGTERM, then SIGKILL after a grace period), including runs this session did not start; dsh_list shows other sessions' runs too. Idempotent. Killing another session's live run destroys its work in flight, so the result marks the run 'own' when it is one this session started and still has running, and 'not this session's active run' otherwise — which covers another session's run and one of yours that has already finished, since the two are indistinguishable from here.",
    parameters: pi.zod.object({
      runId: pi.zod.string().min(1).describe("Run id to kill"),
    }),

    async execute(
      _toolCallId: string,
      params: DshKillParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<KillResult & { label?: string | null }> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      waitOffsets.delete(params.runId);
      waitBuffers.delete(params.runId);
      try {
        const result: KillResult = await killRun(params.runId);
        // Владение определяем через ownRunIds() из моста. В тестах мост замокан, и
        // ownRunIds может не быть функцией — guard обязателен (как около строки 205
        // для session_shutdown): без функции пометку не добавляем, старый текст не ломаем.
        // ownRunIds() отдаёт только ЖИВЫЕ старты этого процесса (async-run.js:ownRunIds,
        // !closed && !spawnError), поэтому отсутствие в списке не доказывает чужого рана:
        // так же выглядит наш собственный, уже завершившийся. Метка это и говорит, а не
        // утверждает чужеродность, которой мы отсюда не видим.
        let ownershipMark = "";
        let ownRun: boolean | undefined;
        if (typeof ownRunIds === "function") {
          const own = ownRunIds().includes(params.runId);
          ownRun = own;
          ownershipMark = own ? " (own)" : " (not this session's active run)";
        }
        const outcome = result.killed ? "killed" : "not killed";
        const text = `kill ${params.runId}: ${outcome} (${result.state})${ownershipMark}`;
        const details = { ...result };
        if (ownRun !== undefined) (details as Record<string, unknown>).ownRun = ownRun;
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: { runId: params.runId, killed: false, state: "error" },
          isError: true,
        };
      }
    },

    renderCall(args: DshKillParams, _options: ToolRenderResultOptions, theme: Theme): Text {
      const runId = typeof args.runId === "string" ? args.runId : String(args.runId ?? "");
      const lab = labelOf(runId);
      const isLabeled = lab !== shortId(runId) && lab.length > 0;
      const display = lab || shortId(runId) || "…";
      const icon = themeIcon(theme, "status.pending", "muted", "●");
      const titleBase = `dsh kill: ${display}`;
      const title = themeFg(theme, "accent", titleBase);
      if (isLabeled) {
        const meta = themeFgDim(theme, shortId(runId));
        return new Text(`${icon} ${title} ${meta}`, 0, 0);
      }
      return new Text(`${icon} ${title}`, 0, 0);
    },

    renderResult(
      result: AgentToolResult<KillResult & { label?: string | null }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ): Text {
      const d = result.details;
      const state = typeof d?.state === "string" ? d.state : "unknown";
      const runId = typeof d?.runId === "string" ? d.runId : "";
      const lab = runId ? labelOf(runId) : "";
      const isLabeled = runId ? lab !== shortId(runId) && lab.length > 0 : false;
      const display = isLabeled ? lab : shortId(runId) || "…";
      const title = themeFg(theme, "accent", `dsh kill: ${display}`);
      if (d?.killed) {
        const icon = themeIcon(theme, "status.done", "success", "✓");
        const meta = themeFgDim(theme, `killed (${state})`);
        return new Text(`${icon} ${title} ${meta}`, 0, 0);
      }
      const icon = themeIcon(theme, "status.error", "error", "✗");
      const meta = themeFgDim(theme, `not killed (${state})`);
      if (result.isError) {
        const txt: string = firstText(result);
        const msg = truncate(oneLine(txt), 200);
        return new Text(
          `${icon} ${title} ${meta}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", msg)}`,
          0,
          0,
        );
      }
      return new Text(`${icon} ${title} ${meta}`, 0, 0);
    },
  });

  registerTypedTool<DshSendParams, SendToRunResult & { runId?: string }>(pi, {
    name: "dsh_send",
    label: "DSH send",
    mergeCallAndResult: true,
    description:
      "Send a message into a RUNNING run started by dsh_spawn — it lands in the current turn, without losing the work already done. Returns one of three statuses (see docs/contracts/dsh-bridge-async-v2.md): 'delivered' — the run's channel reader confirmed reading it; 'pending' — the write reached the channel and the run was still alive on re-check, but reading is not confirmed within the wait window — that's not a delivery guarantee, still do NOT resend it the same way or any other way; 'undeliverable' — the run ended before reading it; resend via dsh_spawn with resumeFromRunId, which works only once the run has left an envelope — without one dsh_spawn throws 'has no session to resume', and that covers a run that is still running as well as a dead one (killed before the envelope, crashed at startup, already swept). Tell the two apart with dsh_list/dsh_wait first: a full new brief without resume is right only for a dead run; for one that is still working it duplicates the work.",
    parameters: pi.zod.object({
      runId: pi.zod.string().min(1).describe("Run id returned by dsh_spawn"),
      text: pi.zod.string().min(1).describe("Message text for the running turn"),
    }),

    async execute(
      _toolCallId: string,
      params: DshSendParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<SendToRunResult & { runId?: string }> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      try {
        const result: SendToRunResult = await sendToRun(params.runId, params.text);
        recordSteer(params.runId, params.text, result.status);
        if (result.status === "pending") {
          // Ран был жив при повторной проверке, сообщение легло в канал —
          // подтверждения чтением нет и гарантии доставки нет. Это НЕ провал:
          // если считать это ошибкой наравне с undeliverable, вызывающий
          // (директор) продублирует сообщение, которое с высокой вероятностью
          // и так будет прочитано — двойной steering (P1 п.4, раунд 2 кросс-ревью).
          return {
            content: [
              {
                type: "text",
                text: `pending: write reached channel, run alive on re-check, reading not confirmed — not a delivery guarantee; do NOT resend it the same way or any other way; verify via the final result (pendingBytes=${result.pendingBytes})`,
              },
            ],
            details: result,
          };
        }
        if (result.status === "undeliverable") {
          return {
            content: [{ type: "text", text: "NOT delivered: run ended before reading; message lost" }],
            details: result,
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `sent to ${params.runId}` }],
          details: result,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        recordSteer(params.runId, params.text, "undeliverable");
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: { delivered: false, status: "undeliverable", steerFile: "", pendingBytes: 0, waitedMs: 0 },
          isError: true,
        };
      }
    },

    renderCall(args: DshSendParams, _options: ToolRenderResultOptions, theme: Theme): Text {
      const runId = typeof args.runId === "string" ? args.runId : String(args.runId ?? "");
      const lab = labelOf(runId);
      const isLabeled = lab !== shortId(runId) && lab.length > 0;
      const display = lab || shortId(runId) || "…";
      const icon = themeIcon(theme, "status.pending", "muted", "●");
      const titleBase = `dsh send: ${display}`;
      const title = themeFg(theme, "accent", titleBase);
      const preview = truncate(oneLine(args.text ?? ""), 100);
      const quoted = `“${preview}”`;
      // Когда показана метка — runId8 в meta, иначе заголовок уже runId8 без дубля
      const meta = isLabeled ? ` ${themeFgDim(theme, shortId(runId))}` : "";
      return new Text(
        `${icon} ${title}${meta}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFgDim(theme, quoted)}`,
        0,
        0,
      );
    },

    renderResult(
      result: AgentToolResult<SendToRunResult & { runId?: string }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ): Text {
      const st = result.details?.status;
      const maybeRunId = result.details?.runId;
      const runIdForLabel = typeof maybeRunId === "string" ? maybeRunId : "";
      const display = runIdForLabel ? labelOf(runIdForLabel) : "…";
      const isLabeled = runIdForLabel ? display !== shortId(runIdForLabel) && display.length > 0 : false;
      const titleBase = themeFg(theme, "accent", `dsh send: ${display}`);
      const titleBaseWithMeta =
        isLabeled && runIdForLabel ? `${titleBase} ${themeFgDim(theme, shortId(runIdForLabel))}` : titleBase;
      if (st === "delivered") {
        const icon = themeIcon(theme, "status.done", "success", "✓");
        const meta = themeFgDim(theme, "delivered");
        return new Text(`${icon} ${titleBaseWithMeta} ${meta}`, 0, 0);
      }
      if (st === "pending") {
        const icon = themeIcon(theme, "status.warning", "warning", "❓");
        const meta = themeFgDim(theme, "pending");
        return new Text(`${icon} ${titleBaseWithMeta} ${meta}`, 0, 0);
      }
      if (st === "undeliverable") {
        const icon = themeIcon(theme, "status.error", "error", "✗");
        const txt: string = firstText(result);
        const reason = txt.includes("NOT delivered")
          ? truncate(oneLine(txt), 200)
          : `not delivered: ${truncate(oneLine(txt), 200)}`;
        return new Text(
          `${icon} ${titleBaseWithMeta}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", reason)}`,
          0,
          0,
        );
      }
      const txt: string = firstText(result);
      const pending = result.details?.pendingBytes;
      const suffix = typeof pending === "number" && pending > 0 ? ` (${pending}B unread)` : "";
      const icon = result.isError
        ? themeIcon(theme, "status.error", "error", "✗")
        : themeIcon(theme, "status.done", "success", "✓");
      return new Text(
        `${icon} ${titleBaseWithMeta} ${themeFgDim(theme, `${truncate(oneLine(txt), 200)}${suffix}`)}`,
        0,
        0,
      );
    },
  });

  registerTypedTool<DshAnswerParams, DshAnswerDetails>(pi, {
    name: "dsh_answer",
    label: "DSH answer",
    mergeCallAndResult: true,
    description:
      "Answer a DSH run that is waiting for input (need_input). Resumes the same DSH session with your answer as the next brief. Pass runId (preferred, quoted in the relay message), or label, or both — with both, runId picks the target run and label names the new run.",
    parameters: pi.zod.object({
      runId: pi.zod
        .string()
        .optional()
        .describe("Run id that asked the question; when label is also given, runId picks the target run"),
      label: pi.zod
        .string()
        .optional()
        .describe(
          "Run label. Alone: resolves the target run (relay map, then dsh_list). Together with runId: only names the new run",
        ),
      answer: pi.zod.string().min(1).describe("Answer text for the waiting run"),
    }),

    async execute(
      _toolCallId: string,
      params: DshAnswerParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<DshAnswerDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      const hasRunId = typeof params.runId === "string" && params.runId.length > 0;
      const hasLabel = typeof params.label === "string" && params.label.length > 0;
      if (!hasRunId && !hasLabel) {
        return {
          content: [{ type: "text", text: "error: runId or label is required" }],
          details: { runId: "", resumedFrom: "", newRunId: "" },
          isError: true,
        };
      }
      let runId = params.runId ?? "";
      let labelForNewRun: string | undefined;
      if (hasRunId && hasLabel) {
        // П.E, смоук 2026-08-26: сообщение relay подсказывает runId, директива учит метке —
        // модель предсказуемо передаёт оба, и «ровно один» ронял валидный по смыслу вызов.
        // Оба — валидно: целевой ран выбирает runId (он точнее), label лишь задаёт метку
        // нового рана. Консистентность пары не проверяем — цель всегда runId.
        labelForNewRun = params.label as string;
      } else if (hasLabel) {
        // P3: сначала relay-карта (последний выигрывает, не чистится при unwatch), фолбэк — скан реестра max startedAt
        const mapped = resolveLabel(params.label as string);
        if (typeof mapped === "string" && mapped.length > 0) {
          runId = mapped;
          labelForNewRun = params.label as string;
        } else {
          const registry: Record<string, RunEntry> = await listRuns();
          const candidates = Object.entries(registry).filter(([, entry]) => {
            const lab = (entry as unknown as { label?: string | null }).label;
            return typeof lab === "string" && lab === params.label;
          });
          if (candidates.length === 0) {
            return {
              content: [{ type: "text", text: `error: no run with label "${params.label}"` }],
              details: { runId: "", resumedFrom: "", newRunId: "" },
              isError: true,
            };
          }
          // самая новая запись (max startedAt), не first-match
          candidates.sort((a, b) => {
            const ta = typeof a[1]?.startedAt === "string" ? Date.parse(a[1].startedAt as string) : -Infinity;
            const tb = typeof b[1]?.startedAt === "string" ? Date.parse(b[1].startedAt as string) : -Infinity;
            return tb - ta;
          });
          runId = candidates[0][0];
          labelForNewRun = params.label as string;
        }
      } else {
        // Ответ ПО runId — основной путь: relay сам пишет в сообщении «(ответить: dsh_answer
        // runId=<runId>)». Метку берём сначала у relay: реестр к этому моменту обычно уже без
        // записи — reapOrphans выметает терминальную ≤30с после вопроса, а без метки цепочка
        // ⟨label⟩ рвалась бы и следующий вопрос пришёл бы как ⟨shortId⟩. Реестр — фолбэк:
        // он один знает метку рана, заведённого не через relay (другая сессия, dsh-bridge CLI).
        labelForNewRun = resolveLabelForRun(runId);
        if (labelForNewRun === undefined) {
          try {
            const registry: Record<string, RunEntry> = await listRuns();
            const entry = registry[runId] as unknown as { label?: string | null } | undefined;
            const lab = entry?.label;
            if (typeof lab === "string" && lab.length > 0) labelForNewRun = lab;
          } catch {
            // ignore registry read errors
          }
        }
      }
      // модель — по тем же правилам, что dsh_spawn (не липкая, наследование роли @dsh)
      const model = resolveRoleModel(ctx);
      const cwd: string = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const dir = await mkdtemp(join(tmpdir(), "dsh-answer-"));
      const taskFile = join(dir, "task.md");
      await writeFile(taskFile, params.answer, "utf8");
      try {
        const handle: RunHandle = await startDsh({
          taskFile,
          resumeFromRunId: runId,
          cwd,
          model,
          askProtocol: true,
          label: labelForNewRun,
          env: { ...process.env } as Record<string, string>,
        });
        if (typeof handle.runId === "string" && handle.runId.length > 0) {
          const relayLabel =
            typeof labelForNewRun === "string" && labelForNewRun.length > 0 ? labelForNewRun : shortId(handle.runId);
          watchRun(handle.runId, relayLabel);
          if (typeof labelForNewRun === "string" && labelForNewRun.length > 0)
            rememberRunLabel(handle.runId, labelForNewRun);
        }
        // П.A: детерминированное закрытие need_input — вопрос закрыт именно УСПЕШНЫМ ответом
        // (startDsh принял resumeFromRunId), а не фактом отправки сообщения когда-то раньше.
        // До этой строки старый ран оставался под наблюдением, и relay повторял напоминание.
        unwatchRun(runId);
        return {
          content: [{ type: "text", text: `answered ${runId} -> ${handle.runId}` }],
          details: { runId: handle.runId, resumedFrom: runId, newRunId: handle.runId, label: labelForNewRun ?? null },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: { runId: "", resumedFrom: runId, newRunId: "" },
          isError: true,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    renderCall(args: DshAnswerParams, _options: ToolRenderResultOptions, theme: Theme): Text {
      const label =
        typeof args.label === "string" && args.label.length > 0
          ? args.label
          : typeof args.runId === "string" && args.runId.length > 0
            ? shortId(args.runId)
            : "…";
      const icon = themeIcon(theme, "status.pending", "muted", "●");
      const title = themeFg(theme, "accent", `dsh answer: ${label}`);
      const preview = truncate(oneLine(args.answer ?? ""), 80);
      const previewLine = ` ${themeFgDim(theme, themeTreeLast(theme))} ${themeFgDim(theme, preview)}`;
      return new Text(`${icon} ${title}\n${previewLine}`, 0, 0);
    },

    renderResult(result: AgentToolResult<DshAnswerDetails>, _options: ToolRenderResultOptions, theme: Theme): Text {
      const isError = Boolean(result.isError);
      if (isError) {
        const txt: string = firstText(result);
        const msg = truncate(oneLine(txt), 300);
        const icon = themeIcon(theme, "status.error", "error", "✗");
        const title = themeFg(theme, "accent", "dsh answer");
        return new Text(
          `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", msg)}`,
          0,
          0,
        );
      }
      const d = result.details as unknown as
        | { runId?: string; resumedFrom?: string; label?: string | null }
        | undefined;
      const label =
        typeof d?.label === "string" && (d.label as string).length > 0
          ? (d.label as string)
          : typeof d?.runId === "string"
            ? shortId(d.runId)
            : "…";
      const icon = themeIcon(theme, "status.done", "success", "✓");
      const title = themeFg(theme, "accent", `dsh answer: ${label}`);
      const meta = typeof d?.runId === "string" && d.runId.length > 0 ? themeFgDim(theme, shortId(d.runId)) : "";
      const header = meta ? `${icon} ${title} ${meta}` : `${icon} ${title}`;
      return new Text(header, 0, 0);
    },
  });

  registerTypedTool<DshListParams, DshListDetails>(pi, {
    name: "dsh_list",
    label: "DSH list",
    mergeCallAndResult: true,
    description: "List runs currently tracked in the DSH bridge registry.",
    parameters: pi.zod.object({}),

    async execute(
      _toolCallId: string,
      _params: DshListParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<DshListDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      if (ctx && typeof ctx === "object" && "ui" in ctx) rememberRunsCtx(ctx);
      try {
        const registry: Record<string, RunEntry> = await listRuns();
        for (const [runId, entry] of Object.entries(registry)) {
          const lab = entry.label;
          if (typeof lab === "string" && lab.length > 0) rememberRunLabel(runId, lab);
        }
        const entries = Object.entries(registry).map(([runId, entry]) => ({ runId, ...entry }));
        // По строке на ран — директор DVIBE ищет здесь runId по метке (label), заданной
        // при dsh_spawn, и вытягивает уточнение напрямую через dsh_send/dsh_wait.
        const summary =
          entries.length === 0
            ? "no active runs"
            : entries
                .map((e) => {
                  const m = e.model;
                  let modelStr = "default";
                  try {
                    if (m) {
                      const raw = formatModelSpec(m);
                      modelStr = raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
                    }
                  } catch {
                    modelStr = "default";
                  }
                  return `${e.runId} state=${e.state} label=${e.label ?? "-"} model=${modelStr} started=${e.startedAt}`;
                })
                .join("\n");
        return {
          content: [{ type: "text", text: summary }],
          details: { runs: entries },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${message}` }],
          details: { runs: [] },
          isError: true,
        };
      }
    },

    renderCall(_args: DshListParams, _options: ToolRenderResultOptions, theme: Theme): Text {
      const icon = themeIcon(theme, "status.pending", "muted", "●");
      const title = themeFg(theme, "accent", "dsh list");
      return new Text(`${icon} ${title}`, 0, 0);
    },

    renderResult(result: AgentToolResult<DshListDetails>, _options: ToolRenderResultOptions, theme: Theme): Text {
      if (result.isError) {
        const txt: string = firstText(result);
        const icon = themeIcon(theme, "status.error", "error", "✗");
        const title = themeFg(theme, "accent", "dsh list");
        return new Text(
          `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFg(theme, "error", truncate(oneLine(txt), 200))}`,
          0,
          0,
        );
      }
      const runs = result.details?.runs;
      if (!Array.isArray(runs) || runs.length === 0) {
        const icon = themeIcon(theme, "status.done", "success", "✓");
        const title = themeFg(theme, "accent", "dsh list");
        return new Text(
          `${icon} ${title}\n ${themeFgDim(theme, themeTreeLast(theme))} ${themeFgDim(theme, "no runs")}`,
          0,
          0,
        );
      }
      const now = Date.now();
      const dot = themeSepDot(theme);
      const total = runs.length;
      let running = 0;
      for (const r of runs) if (r.state === "running") running++;
      const done = total - running;
      const headerIcon = themeIcon(theme, "status.done", "success", "✓");
      const headerTitle = themeFg(theme, "accent", "dsh list");
      const headerMeta = themeFgDim(theme, `${running} running${dot}${done} done`);
      const header = `${headerIcon} ${headerTitle} ${headerMeta}`;
      const lines: string[] = [header];
      const sorted = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      sorted.forEach((e, idx) => {
        const state = typeof e.state === "string" ? e.state : "unknown";
        let icon: string;
        if (state === "running") icon = themeIcon(theme, "status.running", "accent", "●");
        else if (state === "completed") icon = themeIcon(theme, "status.done", "success", "✓");
        else if (state === "need_input") icon = themeIcon(theme, "status.warning", "warning", "❓");
        else if (state === "error" || state === "killed") icon = themeIcon(theme, "status.error", "error", "✗");
        else icon = themeIcon(theme, "status.running", "accent", "●");
        const label = typeof e.label === "string" && e.label.length > 0 ? e.label : shortId(e.runId);
        const elapsed = formatElapsed(e.startedAt, now);
        let modelStr: string;
        try {
          const raw = e.model
            ? formatModelSpec(e.model as unknown as { provider: string; model: string; reasoningEffort?: string })
            : "default";
          modelStr = raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
        } catch {
          modelStr = "default";
        }
        const meta = themeFgDim(theme, [state, elapsed, modelStr].join(dot));
        const isLast = idx === sorted.length - 1;
        const branch = isLast ? themeTreeLast(theme) : (themeTreeBranch(theme) ?? themeTreeLast(theme));
        const dimBranch = themeFgDim(theme, branch);
        lines.push(`${dimBranch} ${icon} ${label} ${meta}`);
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
