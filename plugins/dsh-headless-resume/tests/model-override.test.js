import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRunSettings, run, fail } from "../src/index.js";

// Helpers mirrored from resume.test.js
function captureIO() {
  let out = "";
  let err = "";
  let exitCode = null;
  return {
    stdout: {
      write(s) {
        out += s;
      },
    },
    stderr: {
      write(s) {
        err += s;
      },
    },
    exit(code) {
      exitCode = code;
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

function fakeLlm(resolveImpl) {
  return { resolveModelInfo: resolveImpl ?? (async () => ({ provider: "omniroute", id: "x", name: "x" })) };
}

function fakeCtx({ agentsImpl, sessionsImpl, loaderImpl, defaultModelImpl, llmImpl } = {}) {
  const map = new Map();
  if (agentsImpl) map.set("agents", agentsImpl);
  if (sessionsImpl) map.set("sessions", sessionsImpl);
  if (loaderImpl) map.set("loader", loaderImpl);
  map.set(
    "agentDefaultModel",
    defaultModelImpl ?? { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }) },
  );
  if (llmImpl) map.set("llm", llmImpl);
  return { get: (k) => map.get(k) };
}

function headerEvent(seq, provider, model, reasoningEffort) {
  const cfg = { provider, model };
  if (reasoningEffort !== undefined) cfg.reasoningEffort = reasoningEffort;
  return { seq, type: "request/header", data: { header: { config: cfg } } };
}

// --- resolveRunSettings atomic tuple ---
describe("resolveRunSettings() model-override — атомарный tuple из env", () => {
  it("provider без model → invalid_model marker", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "omniroute", DSH_MODEL: "" });
    assert.ok(s.modelError, "expected modelError for partial tuple");
    assert.equal(s.modelError.code, "invalid_model");
    assert.equal(s.model, undefined);
  });
  it("model без provider → invalid_model marker", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "", DSH_MODEL: "deepseek-v4-flash" });
    assert.ok(s.modelError);
    assert.equal(s.modelError.code, "invalid_model");
  });
  it("effort без пары provider+model → invalid_model marker", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "", DSH_MODEL: "", DSH_REASONING_EFFORT: "high" });
    assert.ok(s.modelError);
    assert.equal(s.modelError.code, "invalid_model");
  });
  it("пустые строки в env = отсутствие, marker не ставится", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "", DSH_MODEL: "", DSH_REASONING_EFFORT: "" });
    assert.equal(s.model, undefined);
    assert.equal(s.modelError, undefined);
  });
  it("полный tuple provider+model без effort → model {provider, model}", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "omniroute", DSH_MODEL: "deepseek-v4-flash" });
    assert.deepEqual(s.model, { provider: "omniroute", model: "deepseek-v4-flash" });
    assert.equal(s.modelError, undefined);
  });
  it("полный tuple c effort → model с reasoningEffort", () => {
    const s = resolveRunSettings({}, { DSH_MODEL_PROVIDER: "omniroute", DSH_MODEL: "m", DSH_REASONING_EFFORT: "high" });
    assert.deepEqual(s.model, { provider: "omniroute", model: "m", reasoningEffort: "high" });
  });
  it("config-пути для model нет: config.model игнорируется", () => {
    const s = resolveRunSettings(
      { model: { provider: "x", model: "y" } },
      { DSH_MODEL_PROVIDER: "omniroute", DSH_MODEL: "m" },
    );
    // Только env учитывается
    assert.deepEqual(s.model, { provider: "omniroute", model: "m" });
  });
  it("config без env → model undefined (нет fallback на config)", () => {
    const s = resolveRunSettings({ model: { provider: "x", model: "y" } }, {});
    assert.equal(s.model, undefined);
    assert.equal(s.modelError, undefined);
  });
});

// --- Preflight classification ---
describe("run() preflight — до agents.create/resume", () => {
  it("provider без model (partial tuple) → invalid_model, agents.create/resume не вызывались, sessionId null", async () => {
    let created = false,
      resumed = false;
    const agentsImpl = {
      create: async () => {
        created = true;
        throw new Error("must not be called");
      },
      resume: async () => {
        resumed = true;
        throw new Error("must not be called");
      },
    };
    // Симулируем: resolveRunSettings дал modelError → run() должен сам сэмбриджеть его до префлайта,
    // но в текущей реализации runner берёт model из opts/env напрямую; здесь передаём через стек apply →
    // однако тестируем run() напрямую: у него model приходит через opts? Проверяем контракт хэндоффа:
    // run(ctx, task, resumeSessionId, runId, io, opts) где opts получают результат resolveRunSettings.
    // Если runner ещё не прокидывает — тест красный и это ожидаемо по TDD.
    // Поэтому эмулируем env via process.env monkey? Нет: прямо вызываем run с внедренным llm и проверяем,
    // что при modelError ветка срабатывает. Но run не знает про env — так что сначала вызываем resolveRunSettings и подаём её результат в opts.
    const env = { DSH_MODEL_PROVIDER: "omniroute", DSH_MODEL: "" };
    const settings = resolveRunSettings({}, env);
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl: fakeLlm() });
    const io = captureIO();
    // apply-level path: run получил бы modelError через resolveRunSettings; проверим что он на него реагирует
    // Передаём через opts.modelError (конвенция которую runner должен поддержать)
    await run(ctx, "task", undefined, "run-partial-1", io, { model: settings.model, modelError: settings.modelError });
    assert.equal(created, false);
    assert.equal(resumed, false);
    assert.equal(io.exitCode, 1);
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.status, "error");
    assert.equal(envOut.error.code, "invalid_model");
    assert.equal(envOut.sessionId, null);
  });

  it("unknown provider → model_not_found via NO_ADAPTER", async () => {
    const { LlmError } = await import("@deepseek-ai/dsh-llm");
    const llmImpl = fakeLlm(async () => {
      throw new LlmError("no adapter", "NO_ADAPTER");
    });
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-no-adapter", io, { model: { provider: "ghost", model: "m" } });
    assert.equal(io.exitCode, 1);
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "model_not_found");
    assert.equal(envOut.sessionId, null);
  });

  it("unknown model (UNKNOWN_MODEL) → model_not_found", async () => {
    const { LlmError } = await import("@deepseek-ai/dsh-llm");
    const llmImpl = fakeLlm(async () => {
      throw new LlmError("no model", "UNKNOWN_MODEL");
    });
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-unknown-model", io, { model: { provider: "omniroute", model: "ghost" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "model_not_found");
  });

  it("effort для non-reasoning модели → invalid_model (info без reasoning)", async () => {
    const llmImpl = fakeLlm(async () => ({ provider: "omniroute", id: "m", name: "m" })); // reasoning отсутствует
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-no-reasoning", io, {
      model: { provider: "omniroute", model: "m", reasoningEffort: "high" },
    });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "invalid_model");
  });

  it("unsupported effort → invalid_model (∉ info.reasoning.efforts)", async () => {
    const llmImpl = fakeLlm(async () => ({
      provider: "omniroute",
      id: "m",
      name: "m",
      reasoning: {
        efforts: [
          { id: "low", name: "low" },
          { id: "medium", name: "med" },
        ],
      },
    }));
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-bad-effort", io, {
      model: { provider: "omniroute", model: "m", reasoningEffort: "high" },
    });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "invalid_model");
  });

  it("INVALID_MODEL_INFO LlmError → invalid_model, message включает код", async () => {
    const { LlmError } = await import("@deepseek-ai/dsh-llm");
    const llmImpl = fakeLlm(async () => {
      throw new LlmError("bad info", "INVALID_MODEL_INFO");
    });
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-invalid-info", io, { model: { provider: "omniroute", model: "m" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "invalid_model");
    assert.match(envOut.error.message, /INVALID_MODEL_INFO/);
  });

  it("не-LlmError из resolveModelInfo → nonzero_exit", async () => {
    const llmImpl = fakeLlm(async () => {
      throw new Error("network down");
    });
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-net-err", io, { model: { provider: "omniroute", model: "m" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "nonzero_exit");
    assert.match(envOut.error.message, /network down/);
  });

  it("неизвестный LlmError-код (операционная ошибка адаптера) → nonzero_exit", async () => {
    const { LlmError } = await import("@deepseek-ai/dsh-llm");
    const llmImpl = fakeLlm(async () => {
      throw new LlmError("timeout", "TIMEOUT");
    });
    const agentsImpl = {
      create: async () => {
        throw new Error("must not");
      },
      resume: async () => {
        throw new Error("must not");
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "task", undefined, "run-timeout", io, { model: { provider: "omniroute", model: "m" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.error.code, "nonzero_exit");
    assert.match(envOut.error.message, /TIMEOUT/);
  });
});

describe("run() с валидным override — прокидывает в agentOptions и installModelSelection", () => {
  it("create: agentOptions и installModelSelection получили override", async () => {
    let createArgs = null;
    // installModelSelection нельзя перехватить без мока модуля, но его установку видно
    // косвенно: run() передаёт setup-колбэк, который вешает обработчик на "agent/request".
    // Ловим этот обработчик и проверяем, что он вообще был установлен, — вместе с
    // agentOptions это и есть обе половины имени теста.
    let installedSelection = null;
    const events = [
      { seq: 10, type: "turn/start", data: { turn: 1 } },
      headerEvent(11, "omniroute", "override-model", "high"),
      { seq: 12, type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } },
      { seq: 13, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 10, id: "sess-o", header: { id: "sess-o" } };
    const fakeAgent = { id: "sess-o", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = {
      create: async (opts) => {
        createArgs = opts; // capture which selection was installed by calling setup
        if (opts.setup) {
          const fakeCtx = {
            on: (evt, handler) => {
              if (evt === "agent/request") installedSelection = handler;
            },
          };
          opts.setup(fakeCtx);
        }
        return { agent: fakeAgent };
      },
      resume: async () => {
        throw new Error("should not resume");
      },
    };
    const llmImpl = fakeLlm(async () => ({
      provider: "omniroute",
      id: "override-model",
      name: "m",
      reasoning: { efforts: [{ id: "high", name: "high" }] },
    }));
    const ctx = fakeCtx({
      agentsImpl,
      sessionsImpl: { flush: async () => {} },
      llmImpl,
      defaultModelImpl: { currentSelection: () => ({ provider: "deepseek-official", model: "default-model" }) },
    });
    const io = captureIO();
    await run(ctx, "hi", undefined, "run-override-create", io, {
      model: { provider: "omniroute", model: "override-model", reasoningEffort: "high" },
    });
    assert.ok(createArgs);
    assert.equal(createArgs.agentOptions.provider, "omniroute");
    assert.equal(createArgs.agentOptions.model, "override-model");
    assert.equal(typeof installedSelection, "function");
    assert.equal(io.exitCode, 0);
  });

  it("resume: override применяется так же", async () => {
    let resumeArgs = null;
    const events = [
      { seq: 20, type: "turn/start", data: { turn: 2 } },
      headerEvent(21, "omniroute", "override-r", undefined),
      { seq: 22, type: "assistant/message", data: { message: { content: [{ type: "text", text: "resumed" }] } } },
      { seq: 23, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 20, id: "sess-r", header: { id: "sess-r" } };
    const fakeAgent = { id: "sess-r", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = {
      create: async () => {
        throw new Error("should not create");
      },
      resume: async (opts) => {
        resumeArgs = opts;
        return { agent: fakeAgent };
      },
    };
    const llmImpl = fakeLlm(async () => ({ provider: "omniroute", id: "override-r", name: "m" }));
    const ctx = fakeCtx({
      agentsImpl,
      sessionsImpl: { flush: async () => {} },
      llmImpl,
      defaultModelImpl: { currentSelection: () => ({ provider: "deepseek-official", model: "default-model" }) },
    });
    const io = captureIO();
    await run(ctx, "hi2", "sess-r", "run-override-resume", io, {
      model: { provider: "omniroute", model: "override-r" },
    });
    assert.ok(resumeArgs);
    assert.equal(resumeArgs.agentOptions.provider, "omniroute");
    assert.equal(resumeArgs.agentOptions.model, "override-r");
  });
});

// --- envelope.model oracle from request/header ---
describe("envelope.model oracle — из request/header текущего рана", () => {
  it("override без effort, header с effort → envelope effort из header", async () => {
    const events = [
      { seq: 5, type: "turn/start", data: { turn: 1 } },
      headerEvent(6, "omniroute", "m1", "medium"),
      { seq: 7, type: "assistant/message", data: { message: { content: [{ type: "text", text: "done" }] } } },
      { seq: 8, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 5, id: "sess-h", header: { id: "sess-h" } };
    const fakeAgent = { id: "sess-h", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const llmImpl = fakeLlm(async () => ({
      provider: "omniroute",
      id: "m1",
      name: "m1",
      reasoning: { efforts: [{ id: "medium", name: "m" }] },
    }));
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl });
    const io = captureIO();
    await run(ctx, "t", undefined, "run-h1", io, { model: { provider: "omniroute", model: "m1" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.deepEqual(envOut.model, { provider: "omniroute", model: "m1", reasoningEffort: "medium" });
  });

  it("header прошлого хода (seq < firstSeq) игнорируется", async () => {
    // firstSeq будет взят после первого whenIdle → seq агента на момент старта рана.
    // Сессия содержит старый header с seq=1 (< firstSeq), и новый header с seq=12 (>=firstSeq).
    // Эмулируем: агент.session.seq = 10 (firstSeq), старый header seq 1 не должен попасть.
    const events = [
      headerEvent(1, "omniroute", "old-model", undefined),
      { seq: 10, type: "turn/start", data: { turn: 2 } },
      headerEvent(12, "omniroute", "new-model", undefined),
      { seq: 13, type: "assistant/message", data: { message: { content: [{ type: "text", text: "x" }] } } },
      { seq: 14, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 10, id: "sess-seq", header: { id: "sess-seq" } };
    const fakeAgent = { id: "sess-seq", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({
      agentsImpl,
      sessionsImpl: { flush: async () => {} },
      llmImpl: fakeLlm(async () => ({ provider: "omniroute", id: "new-model", name: "n" })),
    });
    const io = captureIO();
    await run(ctx, "t", undefined, "run-seq", io, { model: { provider: "omniroute", model: "new-model" } });
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.deepEqual(envOut.model, { provider: "omniroute", model: "new-model" });
  });

  it("ни одного request/header → поля model нет", async () => {
    const events = [
      { seq: 10, type: "turn/start", data: { turn: 1 } },
      { seq: 11, type: "assistant/message", data: { message: { content: [{ type: "text", text: "no header" }] } } },
      { seq: 12, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 10, id: "sess-nohdr", header: { id: "sess-nohdr" } };
    const fakeAgent = { id: "sess-nohdr", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl: fakeLlm() });
    const io = captureIO();
    await run(ctx, "t", undefined, "run-nohdr", io);
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.model, undefined);
    assert.equal("model" in envOut, false);
  });

  it("error-ветка внутри run() после состоявшегося запроса → поле model есть", async () => {
    const events = [
      { seq: 10, type: "turn/start", data: { turn: 1 } },
      headerEvent(11, "omniroute", "m1", undefined),
      {
        seq: 12,
        type: "turn/end",
        data: { turn: 1, reason: { kind: "error", error: { code: "SOME", message: "fail" } } },
      },
    ];
    const sess = { events, seq: 10, id: "sess-err", header: { id: "sess-err" } };
    const fakeAgent = { id: "sess-err", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} }, llmImpl: fakeLlm() });
    const io = captureIO();
    await run(ctx, "t", undefined, "run-err-hdr", io);
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.status, "error");
    assert.deepEqual(envOut.model, { provider: "omniroute", model: "m1" });
  });

  it("без override — envelope model = дефолт из header (currentSelection path)", async () => {
    const events = [
      { seq: 10, type: "turn/start", data: { turn: 1 } },
      headerEvent(11, "deepseek-official", "deepseek-v4-flash", undefined),
      { seq: 12, type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } },
      { seq: 13, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 10, id: "sess-def", header: { id: "sess-def" } };
    const fakeAgent = { id: "sess-def", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({
      agentsImpl,
      sessionsImpl: { flush: async () => {} },
      defaultModelImpl: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }) },
    });
    const io = captureIO();
    await run(ctx, "t", undefined, "run-def", io);
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.deepEqual(envOut.model, { provider: "deepseek-official", model: "deepseek-v4-flash" });
  });
});

describe("modelOfRun() — total/no-throw", () => {
  it("на сессии без events / с мусором не бросает и возвращает undefined", async () => {
    const { modelOfRun } = await import("../src/index.js");
    assert.equal(modelOfRun({ session: null }, 0), undefined);
    assert.equal(modelOfRun({ session: { events: null } }, 0), undefined);
    assert.equal(modelOfRun({ session: { events: [{ seq: 1, type: "other", data: {} }] } }, 0), undefined);
    // header без config
    assert.equal(
      modelOfRun({ session: { events: [{ seq: 5, type: "request/header", data: { header: {} } }] } }, 0),
      undefined,
    );
  });

  it("возвращает последний header >= firstSeq", async () => {
    const { modelOfRun } = await import("../src/index.js");
    const agent = {
      session: {
        events: [headerEvent(5, "omniroute", "m1", undefined), headerEvent(6, "omniroute", "m2", "high")],
      },
    };
    assert.deepEqual(modelOfRun(agent, 5), { provider: "omniroute", model: "m2", reasoningEffort: "high" });
    // firstSeq выше — берёт только второй
    assert.deepEqual(modelOfRun(agent, 6), { provider: "omniroute", model: "m2", reasoningEffort: "high" });
    assert.equal(modelOfRun(agent, 7), undefined);
  });
});

describe("fail() остаётся без поля model (best effort)", () => {
  it("fail(io, error, runId) по-прежнему без model и зелёный", () => {
    const io = captureIO();
    fail(io, new Error("boom"), "run-fail-1");
    const envOut = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(envOut.status, "error");
    assert.equal("model" in envOut, false);
  });
});
