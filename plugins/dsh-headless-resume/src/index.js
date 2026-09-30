import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, isHarnessError, LlmError } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { startSteerChannel } from "./steer-channel.js";

/** Stable Cordis plugin name. */
export const name = "headless-resume-runner";

/** Core services required before the one-shot turn can start. */
export const inject = ["agentDefaultModel", "agents", "sessions", "llm"];

/** Validated config: resume is optional, task required. */
export const Config = z.object({
  task: z.string().required(),
  resumeSessionId: z.string(),
  runId: z.string(),
  /** Путь к steer-каналу; пусто/не задан → канал выключен. */
  steerFile: z.string(),
});

/** Process I/O the runner writes to; tests substitute captures. */
export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * Прочитать журнал сессии как последовательность событий.
 *
 * dsh 0.1.5-rc.1 убрал у Session массив `events`: upstream dsh-headless ходит
 * через `session.seq` + `session.eventAt(SessionSeq(n))`. Старый путь оставлен
 * рабочим, чтобы откат dsh на 0.1.1-rc.2 не ломал плагин. Вся зависимость от
 * версии API живёт здесь одной функцией — не размазана по вызовам.
 *
 * Никогда не бросает: дыры в журнале и битая сессия дают пустую выдачу.
 */
export function* sessionEvents(session) {
  if (!session || typeof session !== "object") return;
  const length = session.seq;
  if (typeof length === "number" && typeof session.eventAt === "function") {
    for (let seq = 0; seq < length; seq++) {
      let event;
      try {
        event = session.eventAt(SessionSeq(seq));
      } catch {
        continue;
      }
      if (event !== undefined && event !== null) yield event;
    }
    return;
  }
  const legacy = session.events;
  if (!Array.isArray(legacy)) return;
  for (const event of legacy) if (event) yield event;
}

/**
 * Aggregate the last assistant text and turn outcome in one owned interval.
 * Mirrors dsh-headless summarize so envelope result matches the printed text.
 */
export function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/**
 * Map a thrown resume/persistence error to a resume envelope code.
 * Contract codes: resume_not_found | resume_corrupt | resume_busy
 */
export function classifyResumeError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  // Corruption / format: SessionPersistenceCorruptionError, SessionFormatUnsupportedError
  if (name === "SessionPersistenceCorruptionError" || name === "SessionFormatUnsupportedError") {
    return { code: "resume_corrupt", message: msg };
  }
  // Heuristic: format refusal strings contain "uses log format v"
  if (/uses log format v\d+/.test(msg)) {
    return { code: "resume_corrupt", message: msg };
  }
  // Corruption message from coordinator.prepareCore catch
  if (/failed validation/.test(msg) || /corrupt/i.test(msg)) {
    return { code: "resume_corrupt", message: msg };
  }

  // Busy / already live
  if (
    /while it is live/.test(msg) ||
    /already has a live/.test(msg) ||
    /preparation is reserved/.test(msg) ||
    /while its persisted preparation is reserved/.test(msg)
  ) {
    return { code: "resume_busy", message: msg };
  }

  // Not found — must be last (many messages contain "not found" but are corrupt/busy checked first)
  if (/not found/.test(msg)) {
    return { code: "resume_not_found", message: msg };
  }

  // Fallback: treat unknown resume failure as corrupt so bridge doesn't mask it as generic error
  return { code: "resume_corrupt", message: msg };
}

/**
 * Build Envelope v1. `runId` defaults to randomUUID when not supplied.
 * `sessionId` is taken from the live runtime session (not from argv).
 * `model` — последняя подготовленная конфигурация conversation-request рана (не доказательство отправки).
 */
export function buildEnvelope({ runId, sessionId, status, result, question, error, exitCode, model }) {
  const envelope = {
    v: 1,
    runId: runId ?? randomUUID(),
    sessionId: sessionId ?? null,
    status,
  };
  if (result !== undefined) envelope.result = result;
  if (question !== undefined) envelope.question = question;
  if (model !== undefined) envelope.model = model;
  if (error !== undefined) {
    envelope.error = {
      code: error.code,
      message: error.message,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  return envelope;
}

/**
 * Totally-safe проекция последнего request/header текущего рана.
 * На битой сессии возвращает undefined, никогда не бросает.
 */
export function modelOfRun(agent, firstSeq) {
  try {
    let last;
    for (const ev of sessionEvents(agent?.session)) {
      if (!ev || typeof ev.seq !== "number" || ev.seq < firstSeq) continue;
      if (ev.type !== "request/header") continue;
      const cfg = ev?.data?.header?.config;
      if (!cfg || typeof cfg.provider !== "string" || typeof cfg.model !== "string") continue;
      const out = { provider: cfg.provider, model: cfg.model };
      if (typeof cfg.reasoningEffort === "string" && cfg.reasoningEffort !== "")
        out.reasoningEffort = cfg.reasoningEffort;
      last = out;
    }
    return last;
  } catch {
    return undefined;
  }
}

/** Print envelope as single-line JSON to stdout (last line contract). */
export function printEnvelope(io, envelope) {
  io.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function preflightFail(io, runId, code, message) {
  const envelope = buildEnvelope({ runId, sessionId: null, status: "error", error: { code, message }, exitCode: 1 });
  io.stderr.write(`dsh: ${code}: ${message}\n`);
  printEnvelope(io, envelope);
  io.exit(1);
}

/**
 * Последний рубеж: apply() зовёт это из .catch() на run(...), когда исключение
 * (например из agent.whenIdle/followup/flush) долетело до самого верха. Раньше
 * fail() печатал только stderr и не печатал envelope — контракт «envelope
 * последней строкой stdout» нарушался ровно там, где он важнее всего: bridge
 * (tryParseEnvelopeFromStdout) не находит envelope и вынужден сам гадать код
 * ошибки по exit-коду/тексту stdout, вместо честного nonzero_exit с реальным
 * сообщением. runId берём тем же способом, что apply() — resolveRunSettings;
 * если его не было и там, buildEnvelope сгенерирует свой (та же деградация,
 * что и везде в этом файле).
 */
export function fail(io, error, runId) {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr.write(`dsh: ${message}\n`);
  const envelope = buildEnvelope({
    runId,
    sessionId: null,
    status: "error",
    error: { code: "nonzero_exit", message },
    exitCode: 1,
  });
  printEnvelope(io, envelope);
  io.exit(1);
}

/**
 * Run one task: resume or create, drive to idle, flush, emit human text + envelope.
 */
/** Маркер, которым persona просит модель оформлять вопрос к пользователю. */
export const NEED_INPUT_MARKER = "NEED_INPUT:";

/**
 * Распознаёт вопрос модели в тексте ответа.
 *
 * Нужен потому, что `blocked` из agent-loop — это НЕ «модель спросила»:
 * он возникает при `decision.kind === "reject"` в preStep
 * (dsh-agent-loop/lib/index.js:539), то есть когда шаг отклонил гейт. Модель,
 * задавшая вопрос, штатно завершает ход как `completed` с текстом-вопросом —
 * проверено живым раном. Поэтому вопрос помечается маркером в persona и
 * распознаётся здесь.
 *
 * @returns {{question: string, text: string}|null} null, если вопроса нет.
 */
export function detectNeedInput(text) {
  if (typeof text !== "string") return null;
  const idx = text.lastIndexOf(NEED_INPUT_MARKER);
  if (idx === -1) return null;
  // Маркер обязан начинать строку: иначе любое упоминание в прозе стало бы вопросом.
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  if (text.slice(lineStart, idx).trim() !== "") return null;
  const question = text.slice(idx + NEED_INPUT_MARKER.length).trim();
  if (question === "") return null;
  return { question, text: text.slice(0, lineStart).trimEnd() };
}

export async function run(ctx, task, resumeSessionId, runId, io, opts = {}) {
  await ctx.get("loader")?.await();

  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  const llm = ctx.get("llm");

  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;

  // opts.model / opts.modelError приходят из resolveRunSettings (env-атомарный tuple).
  // Если есть modelError — это частичный набор (provider без model и т.п.) → invalid_model без обращения к llm.
  if (opts.modelError) {
    const code = opts.modelError.code ?? "invalid_model";
    const message = opts.modelError.message ?? "invalid model override";
    preflightFail(io, runId, code, message);
    return;
  }

  let selection = defaultModel.currentSelection();
  // Preflight: валидация override до agents.create/resume
  if (opts.model !== undefined) {
    if (llm === undefined || typeof llm.resolveModelInfo !== "function") {
      preflightFail(io, runId, "nonzero_exit", "llm service unavailable for model override");
      return;
    }
    try {
      const info = await llm.resolveModelInfo(opts.model.provider, opts.model.model);
      // effort задан, а модель non-reasoning
      if (opts.model.reasoningEffort !== undefined && opts.model.reasoningEffort !== "") {
        if (!info?.reasoning) {
          preflightFail(
            io,
            runId,
            "invalid_model",
            `provider "${opts.model.provider}" model "${opts.model.model}" does not support reasoning effort "${opts.model.reasoningEffort}"`,
          );
          return;
        }
        const ids = (info.reasoning.efforts ?? []).map((e) => e.id);
        if (!ids.includes(opts.model.reasoningEffort)) {
          preflightFail(
            io,
            runId,
            "invalid_model",
            `provider "${opts.model.provider}" model "${opts.model.model}" does not support reasoning effort "${opts.model.reasoningEffort}"`,
          );
          return;
        }
      }
      selection = opts.model;
    } catch (error) {
      const code = error?.code;
      const msg = error instanceof Error ? error.message : String(error);
      const tagged = `${code ?? "unknown"}: ${msg}`;
      // Классификация по таблице §3.3
      if (error instanceof LlmError || isHarnessError(error)) {
        if (code === "NO_ADAPTER" || code === "UNKNOWN_MODEL") {
          preflightFail(io, runId, "model_not_found", tagged);
          return;
        }
        if (
          code === "INVALID_MODEL_INFO" ||
          code === "INVALID_MODEL_CONTEXT" ||
          code === "INVALID_MODEL_REASONING" ||
          code === "INVALID_MODEL_MAX_TOKENS"
        ) {
          preflightFail(io, runId, "invalid_model", tagged);
          return;
        }
        preflightFail(io, runId, "nonzero_exit", tagged);
        return;
      }
      preflightFail(io, runId, "nonzero_exit", tagged);
      return;
    }
  }
  let agent;
  let sessionIdForEnvelope = null;

  // --- Acquire agent (resume vs create) ---
  try {
    if (resumeSessionId !== undefined && resumeSessionId !== "") {
      const handle = await agents.resume({
        resumeSessionId,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, {
            current: selection,
            assembled: undefined,
          });
        },
      });
      agent = handle.agent;
    } else {
      const newId = SessionId(`session-${randomUUID()}`);
      const { agent: created } = await agents.create({
        sessionId: newId,
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, {
            current: selection,
            assembled: undefined,
          });
        },
      });
      agent = created;
    }
  } catch (error) {
    // Resume acquisition failure → envelope error, exit != 0
    const classified = classifyResumeError(error);
    const envelope = buildEnvelope({
      runId,
      sessionId: null,
      status: "error",
      error: classified,
      exitCode: 1,
    });
    io.stderr.write(`dsh: ${classified.code}: ${classified.message}\n`);
    printEnvelope(io, envelope);
    io.exit(1);
    return;
  }

  sessionIdForEnvelope = agent.session.id ?? agent.id ?? null;

  await agent.whenIdle();
  const firstSeq = agent.session.seq;

  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: task }],
      source: { kind: "user" },
    }),
  );

  // Steer-канал стартует ТОЛЬКО после followup: раньше сообщение попало бы в
  // next-step ещё не начатого хода. Канал не задан → поведение прежнее.
  const steerFile = opts.steerFile;
  const steer =
    typeof steerFile === "string" && steerFile !== ""
      ? startSteerChannel(agent, steerFile, {
          createUserMessage,
          onWarn: (message) => io.stderr.write(`dsh: ${message}\n`),
        })
      : undefined;

  try {
    await agent.whenIdle();
  } finally {
    // Обязательно: висящий таймер опроса не дал бы процессу выйти.
    steer?.stop();
  }
  await sessions.flush(agent.session);

  const outcome = summarize(sessionEvents(agent.session), firstSeq);

  // Human text first (backward compat with pre-envelope expectations)
  io.stdout.write(outcome.text + (outcome.text.endsWith("\n") ? "" : "\n"));

  // Envelope as last line — contract requires sessionId from runtime
  const reason = outcome.reason;
  let envelope;

  const runModel = modelOfRun(agent, firstSeq);
  if (reason?.kind === "completed") {
    // Вопрос к пользователю приходит именно так: ход завершён нормально, а
    // текст помечен маркером из persona (см. detectNeedInput).
    const asked = detectNeedInput(outcome.text);
    envelope = asked
      ? buildEnvelope({
          runId,
          sessionId: sessionIdForEnvelope,
          status: "need_input",
          question: asked.question,
          ...(runModel !== undefined ? { model: runModel } : {}),
        })
      : buildEnvelope({
          runId,
          sessionId: sessionIdForEnvelope,
          status: "completed",
          result: outcome.text,
          ...(runModel !== undefined ? { model: runModel } : {}),
        });
    printEnvelope(io, envelope);
    io.exit(0);
  } else if (reason?.kind === "blocked") {
    // Шаг отклонён гейтом (preStep reject) — это не вопрос модели, но
    // продолжать ран тоже нельзя: спрашиваем владельца, что делать.
    const question = reason.message ?? reason.reason?.message ?? "DSH needs input to continue";
    envelope = buildEnvelope({
      runId,
      sessionId: sessionIdForEnvelope,
      status: "need_input",
      question,
      ...(runModel !== undefined ? { model: runModel } : {}),
    });
    printEnvelope(io, envelope);
    // need_input is not an error; exit 0 so bridge can distinguish via envelope status
    io.exit(0);
  } else if (reason?.kind === "error") {
    const code = reason.error?.code ?? "UNKNOWN";
    const message = reason.error?.message ?? String(reason.error ?? "unknown error");
    io.stderr.write(`dsh: ${code}: ${message}\n`);
    envelope = buildEnvelope({
      runId,
      sessionId: sessionIdForEnvelope,
      status: "error",
      error: { code: "nonzero_exit", message: `${code}: ${message}` },
      exitCode: 1,
      ...(runModel !== undefined ? { model: runModel } : {}),
    });
    printEnvelope(io, envelope);
    io.exit(1);
  } else if (reason?.kind === "aborted" || reason?.kind === "interrupted" || reason?.kind === "max-tokens") {
    const label = reason.kind;
    envelope = buildEnvelope({
      runId,
      sessionId: sessionIdForEnvelope,
      status: "error",
      error: { code: "nonzero_exit", message: `turn ended with ${label}` },
      exitCode: 1,
      ...(runModel !== undefined ? { model: runModel } : {}),
    });
    printEnvelope(io, envelope);
    io.exit(1);
  } else if (reason === undefined || reason === null) {
    // No turn/end observed — treat as error (bridge will also see malformed if we omitted envelope; we don't omit)
    envelope = buildEnvelope({
      runId,
      sessionId: sessionIdForEnvelope,
      status: "error",
      error: { code: "nonzero_exit", message: "no turn result" },
      exitCode: 1,
      ...(runModel !== undefined ? { model: runModel } : {}),
    });
    printEnvelope(io, envelope);
    io.exit(1);
  } else {
    envelope = buildEnvelope({
      runId,
      sessionId: sessionIdForEnvelope,
      status: "error",
      error: { code: "nonzero_exit", message: `turn ended with ${reason.kind}` },
      exitCode: 1,
      ...(runModel !== undefined ? { model: runModel } : {}),
    });
    printEnvelope(io, envelope);
    io.exit(1);
  }
}

/**
 * Mount the resume-aware driver.
 */
/**
 * Откуда раннер берёт runId и путь к steer-каналу.
 *
 * Bridge запускает процесс и знает оба значения, но передать их через
 * cordis-конфиг не может: патч профиля статичен. Поэтому передаёт окружением, а
 * config остаётся более сильным — явная настройка профиля должна побеждать.
 *
 * Пустая строка в окружении трактуется как отсутствие значения: иначе
 * `DSH_RUN_ID=` дал бы envelope с пустым runId, который bridge не сопоставит
 * ни с одним раном.
 */
export function resolveRunSettings(config = {}, env = process.env) {
  const pick = (fromConfig, fromEnv) => {
    if (typeof fromConfig === "string" && fromConfig !== "") return fromConfig;
    if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
    return undefined;
  };
  const norm = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const provider = norm(env.DSH_MODEL_PROVIDER);
  const modelName = norm(env.DSH_MODEL);
  const effort = norm(env.DSH_REASONING_EFFORT);
  let model;
  let modelError;
  if (provider !== undefined || modelName !== undefined || effort !== undefined) {
    if (provider !== undefined && modelName !== undefined) {
      model = { provider, model: modelName };
      if (effort !== undefined) model.reasoningEffort = effort;
    } else {
      // частичный набор — атомарность нарушена → invalid_model
      const parts = [];
      if (provider === undefined) parts.push("provider missing");
      if (modelName === undefined) parts.push("model missing");
      if (effort !== undefined && provider === undefined) parts.push("effort without provider/model");
      // effort без пары тоже invalid_model (уже покрыто provider/model missing)
      modelError = { code: "invalid_model", message: `invalid model override: ${parts.join(", ")}` };
    }
  }
  return {
    runId: pick(config.runId, env.DSH_RUN_ID),
    steerFile: pick(config.steerFile, env.DSH_STEER_FILE),
    ...(model !== undefined ? { model } : {}),
    ...(modelError !== undefined ? { modelError } : {}),
  };
}

export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === undefined)
    throw new Error("headless-resume-runner: the launcher must provide ctx.appExit before the tree mounts");
  const io = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit,
  };
  const task = config.task;
  const resumeSessionId = config.resumeSessionId;
  const { runId, steerFile, model, modelError } = resolveRunSettings(config);
  run(ctx, task, resumeSessionId, runId, io, { steerFile, model, modelError }).catch((error) => {
    fail(io, error, runId);
  });
}
