import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test src/index.js in isolation with mocked dsh-* peers.
// Real peer modules are stubbed via --experimental-vm-modules loader? Instead we import
// the file under test and mock its upstream deps by intercepting the ESM imports through
// a tiny in-test shim: we load the module after installing a custom loader in the global
// import map — simplest is to test classify/summarize/buildEnvelope/printEnvelope directly
// and to exercise `run()` via dependency injection of ctx over a fake agents/sessions layer.

// Import the module under test (it will import real peers, but we never exercise the
// peer-dependent branches without a fake ctx; the pure helpers are unaffected).
import {
  summarize,
  classifyResumeError,
  buildEnvelope,
  printEnvelope,
  run,
  resolveRunSettings,
  detectNeedInput,
  fail,
} from "../src/index.js";

// Helpers

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

// --- Pure helpers ---

describe("summarize()", () => {
  it("returns last assistant text and last turn/end reason after firstSeq", () => {
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "hello " }] } } },
      { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "world" }] } } },
      { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const { text, reason } = summarize(events, 0);
    assert.equal(text, "world");
    assert.deepEqual(reason, { kind: "completed" });
  });

  it("ignores events before firstSeq and before turn/start", () => {
    // summarize skips events with seq < firstSeq AND skips assistant messages before turn/start.
    // So leaked message at seq 0 (<5 and before any turn/start) is ignored regardless.
    const events = [
      { seq: 0, type: "assistant/message", data: { message: { content: [{ type: "text", text: "leaked" }] } } },
      { seq: 5, type: "turn/start", data: { turn: 1 } },
      { seq: 6, type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } },
      { seq: 7, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    // firstSeq=5 → only events with seq >=5 are considered, and text "ok" comes after turn/start → counted
    const { text } = summarize(events, 5);
    assert.equal(text, "ok");
    // firstSeq=7 → only turn/end at seq 7 passes seq filter, no assistant message after firstSeq → empty
    const { text: empty } = summarize(events, 8);
    assert.equal(empty, "");
  });
  it("joins only text blocks", () => {
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      {
        seq: 1,
        type: "assistant/message",
        data: { message: { content: [{ type: "tool-call", id: "1", name: "x" }] } },
      },
      {
        seq: 2,
        type: "assistant/message",
        data: {
          message: {
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        },
      },
      { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const { text } = summarize(events, 0);
    assert.equal(text, "ab");
  });
});

describe("classifyResumeError()", () => {
  it('maps "not found" to resume_not_found', () => {
    const e = new Error('session "foo" not found');
    assert.equal(classifyResumeError(e).code, "resume_not_found");
  });

  it("maps SessionPersistenceCorruptionError to resume_corrupt", () => {
    const e = new Error('stored session "foo" failed validation: bad json');
    e.name = "SessionPersistenceCorruptionError";
    assert.equal(classifyResumeError(e).code, "resume_corrupt");
  });

  it("maps SessionFormatUnsupportedError to resume_corrupt", () => {
    const e = new Error('session "foo" uses log format v9, but this harness reads only v0');
    e.name = "SessionFormatUnsupportedError";
    assert.equal(classifyResumeError(e).code, "resume_corrupt");
  });

  it("maps format refusal string to resume_corrupt", () => {
    const e = new Error('session "x" uses log format v5, but this harness reads only v0');
    assert.equal(classifyResumeError(e).code, "resume_corrupt");
  });

  it("maps live-session error to resume_busy", () => {
    const e = new Error('cannot prepare session "x" while it is live');
    assert.equal(classifyResumeError(e).code, "resume_busy");
  });

  it('maps "already has a live persistence owner" to resume_busy', () => {
    const e = new Error('session "x" already has a live persistence owner');
    assert.equal(classifyResumeError(e).code, "resume_busy");
  });

  it("maps reserved preparation to resume_busy", () => {
    const e = new Error('cannot append session "x" while its persisted preparation is reserved');
    assert.equal(classifyResumeError(e).code, "resume_busy");
  });

  it("fallbacks to resume_corrupt for unknown", () => {
    const e = new Error("something else broke");
    assert.equal(classifyResumeError(e).code, "resume_corrupt");
  });
});

describe("buildEnvelope()", () => {
  it("builds completed envelope with required fields", () => {
    const e = buildEnvelope({ runId: "r1", sessionId: "s1", status: "completed", result: "hi" });
    assert.equal(e.v, 1);
    assert.equal(e.runId, "r1");
    assert.equal(e.sessionId, "s1");
    assert.equal(e.status, "completed");
    assert.equal(e.result, "hi");
    assert.equal(e.error, undefined);
  });

  it("builds error envelope with code", () => {
    const e = buildEnvelope({
      runId: "r2",
      sessionId: null,
      status: "error",
      error: { code: "resume_not_found", message: "nope" },
      exitCode: 1,
    });
    assert.equal(e.status, "error");
    assert.equal(e.error.code, "resume_not_found");
    assert.equal(e.error.exitCode, 1);
  });

  it("generates runId when omitted", () => {
    const e = buildEnvelope({ sessionId: "s", status: "completed", result: "x" });
    assert.ok(typeof e.runId === "string" && e.runId.length > 0);
  });
});

describe("printEnvelope()", () => {
  it("writes single-line JSON", () => {
    const io = captureIO();
    const env = buildEnvelope({ runId: "r", sessionId: "s", status: "completed", result: "ok" });
    printEnvelope(io, env);
    const lines = io.out.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.result, "ok");
  });
});

// --- run() with faked Cordis ctx ---

describe("run() — resume vs create + envelope last line", () => {
  function fakeCtx({ agentsImpl, sessionsImpl, loaderImpl } = {}) {
    const map = new Map();
    if (agentsImpl) map.set("agents", agentsImpl);
    if (sessionsImpl) map.set("sessions", sessionsImpl);
    if (loaderImpl) map.set("loader", loaderImpl);
    // defaultModel
    map.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }),
    });
    return {
      get: (k) => map.get(k),
    };
  }

  it("calls agents.create for fresh session and prints completed envelope last line (sessionId from runtime)", async () => {
    let createArgs = null;
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      {
        seq: 1,
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "hello from fresh" }] } },
      },
      { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 0, id: "new-sess-xyz", header: { id: "new-sess-xyz" } };
    const fakeAgent = { id: "new-sess-xyz", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = {
      create: async (opts) => {
        createArgs = opts;
        return { agent: fakeAgent };
      },
      resume: async () => {
        throw new Error("should not resume");
      },
    };
    const sessionsImpl = { flush: async () => {} };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl });
    const io = captureIO();

    await run(ctx, "do the thing", undefined, "run-1", io);

    assert.ok(createArgs !== null, "agents.create was called");
    assert.equal(createArgs.meta.cwd, process.cwd());
    assert.equal(io.exitCode, 0);
    // stdout = human text lines + envelope last line
    const lines = io.out.trim().split("\n");
    assert.equal(lines[0], "hello from fresh");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.equal(env.v, 1);
    assert.equal(env.runId, "run-1");
    assert.equal(env.sessionId, "new-sess-xyz");
    assert.equal(env.status, "completed");
    assert.equal(env.result, "hello from fresh");
  });

  it("calls agents.resume when resumeSessionId given and preserves that id in envelope", async () => {
    let resumeArgs = null;
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "resumed output" }] } } },
      { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 0, id: "existing-id", header: { id: "existing-id" } };
    const fakeAgent = { id: "existing-id", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = {
      create: async () => {
        throw new Error("should not create");
      },
      resume: async (opts) => {
        resumeArgs = opts;
        return { agent: fakeAgent };
      },
    };
    const sessionsImpl = { flush: async () => {} };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl });
    const io = captureIO();

    await run(ctx, "continue", "existing-id", "run-2", io);

    assert.ok(resumeArgs !== null);
    assert.equal(resumeArgs.resumeSessionId, "existing-id");
    // sessionId in envelope comes from runtime, not argv — they coincide for resume
    const lines = io.out.trim().split("\n");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.equal(env.sessionId, "existing-id");
    assert.equal(env.status, "completed");
    assert.equal(env.result, "resumed output");
    assert.equal(io.exitCode, 0);
  });

  it('maps resume "not found" to resume_not_found envelope with exit!=0 and sessionId null', async () => {
    const agentsImpl = {
      create: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        throw new Error('session "ghost" not found');
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", "ghost", "run-3", io);

    assert.equal(io.exitCode, 1);
    assert.match(io.err, /resume_not_found/);
    const lines = io.out.trim().split("\n");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.equal(env.status, "error");
    assert.equal(env.error.code, "resume_not_found");
    assert.equal(env.sessionId, null);
    assert.equal(env.error.exitCode, 1);
  });

  it("maps corruption to resume_corrupt", async () => {
    const e = new Error('stored session "s" failed validation: bad');
    e.name = "SessionPersistenceCorruptionError";
    const agentsImpl = {
      create: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        throw e;
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", "s", "run-4", io);

    const env = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(env.error.code, "resume_corrupt");
    assert.equal(io.exitCode, 1);
  });

  it("maps live/busy to resume_busy", async () => {
    const agentsImpl = {
      create: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        throw new Error('cannot prepare session "s" while it is live');
      },
    };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", "s", "run-5", io);

    const env = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(env.error.code, "resume_busy");
    assert.equal(io.exitCode, 1);
  });

  it("handles blocked reason as need_input with question", async () => {
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } },
    ];
    const sess = { events, seq: 0, id: "s-blocked", header: { id: "s-blocked" } };
    const fakeAgent = { id: "s-blocked", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", undefined, "run-6", io);

    const env = JSON.parse(io.out.trim().split("\n").at(-1));
    assert.equal(env.status, "need_input");
    assert.ok(typeof env.question === "string" && env.question.length > 0);
    assert.equal(env.sessionId, "s-blocked");
    assert.equal(io.exitCode, 0);
  });

  it("envelope is always the last stdout line", async () => {
    const events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "line1\nline2" }] } } },
      { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const sess = { events, seq: 0, id: "s1", header: { id: "s1" } };
    const fakeAgent = { id: "s1", session: sess, whenIdle: async () => {}, followup() {} };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", undefined, "run-7", io);

    const lines = io.out.trim().split("\n");
    const last = lines[lines.length - 1];
    const parsed = JSON.parse(last);
    assert.equal(parsed.v, 1);
    // human text appears before envelope
    assert.ok(io.out.includes("line1"));
  });

  it("исключение из agent.whenIdle НЕ ломает контракт «envelope последней строкой» (через fail())", async () => {
    // whenIdle бросает уже ПОСЛЕ acquire (агент получен), поэтому исключение
    // не ловится собственным try/catch run() (тот покрывает только acquire) и
    // долетает до вызывающего — apply() ловит его и зовёт fail(io, error, runId).
    // Здесь эмулируем ровно то, что делает apply().
    const sess = { events: [], seq: 0, id: "s-throw", header: { id: "s-throw" } };
    const fakeAgent = {
      id: "s-throw",
      session: sess,
      whenIdle: async () => {
        throw new Error("whenIdle exploded");
      },
      followup() {},
    };
    const agentsImpl = { create: async () => ({ agent: fakeAgent }), resume: async () => ({ agent: fakeAgent }) };
    const ctx = fakeCtx({ agentsImpl, sessionsImpl: { flush: async () => {} } });
    const io = captureIO();

    await run(ctx, "task", undefined, "run-throw-1", io).catch((error) => fail(io, error, "run-throw-1"));

    assert.equal(io.exitCode, 1);
    const lines = io.out.trim().split("\n");
    const last = lines[lines.length - 1];
    const env = JSON.parse(last);
    assert.equal(env.v, 1);
    assert.equal(env.status, "error");
    assert.equal(env.error.code, "nonzero_exit");
    assert.match(env.error.message, /whenIdle exploded/);
    assert.equal(env.runId, "run-throw-1");
    assert.match(io.err, /whenIdle exploded/);
  });
});

describe("resolveRunSettings()", () => {
  it("берёт runId и steerFile из окружения, когда их нет в config", () => {
    const s = resolveRunSettings({}, { DSH_RUN_ID: "run-env", DSH_STEER_FILE: "/tmp/a.steer.jsonl" });
    assert.equal(s.runId, "run-env");
    assert.equal(s.steerFile, "/tmp/a.steer.jsonl");
  });

  it("config сильнее окружения: явная настройка профиля побеждает", () => {
    const s = resolveRunSettings(
      { runId: "run-cfg", steerFile: "/tmp/cfg.jsonl" },
      { DSH_RUN_ID: "run-env", DSH_STEER_FILE: "/tmp/env.jsonl" },
    );
    assert.equal(s.runId, "run-cfg");
    assert.equal(s.steerFile, "/tmp/cfg.jsonl");
  });

  it("пустая строка в окружении — это отсутствие значения, а не пустой runId", () => {
    const s = resolveRunSettings({}, { DSH_RUN_ID: "", DSH_STEER_FILE: "" });
    assert.equal(s.runId, undefined);
    assert.equal(s.steerFile, undefined);
  });

  it("без окружения и без config — ничего не выдумывает", () => {
    const s = resolveRunSettings({}, {});
    assert.equal(s.runId, undefined);
    assert.equal(s.steerFile, undefined);
  });
});

describe("detectNeedInput()", () => {
  it("маркер в начале последней строки превращает ответ в вопрос", () => {
    const got = detectNeedInput("Сделал первую часть.\nNEED_INPUT: какой порт использовать?");
    assert.equal(got.question, "какой порт использовать?");
    assert.equal(got.text, "Сделал первую часть.");
  });

  it("вопрос может быть многострочным", () => {
    const got = detectNeedInput("NEED_INPUT: уточни:\n1) СУБД\n2) путь");
    assert.equal(got.question, "уточни:\n1) СУБД\n2) путь");
    assert.equal(got.text, "");
  });

  it("упоминание маркера в середине строки — не вопрос", () => {
    assert.equal(detectNeedInput("я мог бы написать NEED_INPUT: но не буду"), null);
  });

  it("нет маркера — нет вопроса", () => {
    assert.equal(detectNeedInput("обычный ответ про черепах"), null);
  });

  it("маркер без текста вопроса игнорируется", () => {
    assert.equal(detectNeedInput("готово\nNEED_INPUT:   "), null);
  });

  it("берётся последний маркер, если модель написала их несколько", () => {
    const got = detectNeedInput("NEED_INPUT: первый\nответ\nNEED_INPUT: второй");
    assert.equal(got.question, "второй");
  });
});

describe("fail()", () => {
  // apply() зовёт fail() из .catch() на run(...) — единственное место, где
  // исключение из whenIdle/followup/flush долетает без собственного envelope
  // (run() сам печатает envelope только на известных путях: acquire-ошибка и
  // штатное завершение хода). Без этого теста контракт «envelope последней
  // строкой» держался бы только для ожидаемых ошибок, а не для любого throw.
  it("печатает валидный error-envelope последней строкой и exit(1)", () => {
    const io = captureIO();
    fail(io, new Error("boom"), "run-fail-1");

    assert.equal(io.exitCode, 1);
    assert.match(io.err, /boom/);
    const lines = io.out.trim().split("\n");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.equal(env.v, 1);
    assert.equal(env.status, "error");
    assert.equal(env.sessionId, null);
    assert.equal(env.error.code, "nonzero_exit");
    assert.match(env.error.message, /boom/);
    assert.equal(env.runId, "run-fail-1");
  });

  it("без runId (config и DSH_RUN_ID оба отсутствовали) — envelope всё равно валиден", () => {
    const io = captureIO();
    fail(io, new Error("no runId available"), undefined);

    const lines = io.out.trim().split("\n");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.equal(env.status, "error");
    assert.ok(typeof env.runId === "string" && env.runId.length > 0, "buildEnvelope генерирует runId сам");
  });

  it("принимает не-Error значение так же, как остальной run() (String(error))", () => {
    const io = captureIO();
    fail(io, "plain string failure", "run-fail-2");

    const lines = io.out.trim().split("\n");
    const env = JSON.parse(lines[lines.length - 1]);
    assert.match(env.error.message, /plain string failure/);
  });
});
