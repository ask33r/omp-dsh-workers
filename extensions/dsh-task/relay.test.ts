import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mock bridge ---
// Возвращаемый тип каждого мока подписан типом настоящего bridge-core: иначе `mock()`
// выводит тип по ПЕРВОЙ реализации («state всегда running»), и любая последующая
// mockImplementation с другим законным состоянием рана перестаёт проходить проверку
// типов. `import type` стирается компилятором и mock.module ниже не задевает.
import type {
  Envelope,
  KillRunResult,
  PollRunResult,
  ReadRunOutputResult,
  RunHandle,
  SendToRunResult,
} from "../../tools/dsh-bridge/src/index.js";

const startDshMock = mock(
  async (_opts: unknown): Promise<RunHandle> => ({
    runId: "new-run-1",
    pid: 4242,
    pgid: 4242,
    logFile: "/tmp/new-run-1.log",
    startedAt: new Date().toISOString(),
  }),
);

const pollRunMock = mock(
  async (_runId: string, _opts: unknown): Promise<PollRunResult> => ({
    runId: "run-1",
    state: "running" as const,
    envelope: null,
    exitCode: null,
  }),
);

const listRunsMock = mock(async (_registryPath?: string) => ({}) as Record<string, unknown>);

const runDshMock = mock(
  async (_opts: unknown): Promise<Envelope> => ({
    v: 1 as const,
    runId: "run-1",
    sessionId: null,
    status: "completed" as const,
    result: "hello",
  }),
);

const waitRunMock = mock(
  async (_runId: string, _opts: { waitMs: number }): Promise<PollRunResult> => ({
    runId: "run-1",
    state: "running" as const,
    envelope: null,
    exitCode: null,
  }),
);
const killRunMock = mock(
  async (_runId: string): Promise<KillRunResult> => ({ runId: _runId, killed: true, state: "error" as const }),
);
const readRunOutputMock = mock(
  async (_runId: string, opts: unknown): Promise<ReadRunOutputResult> => ({
    chunk: "",
    nextOffset: (opts as { offset?: number })?.offset ?? 0,
    eof: true,
  }),
);
const sendToRunMock = mock(
  async (): Promise<SendToRunResult> => ({
    delivered: true,
    status: "delivered" as const,
    steerFile: "",
    pendingBytes: 0,
    waitedMs: 0,
  }),
);
const sweepRunsMock = mock(async () => ({ expired: [], reasons: {}, removed: [], killed: [] }));
const sessionIdOfRunMock = mock(async () => null);
const ownRunIdsMock = mock(() => [] as string[]);
const renewLeaseMock = mock(async (_runId: string, _opts?: unknown) => "2026-08-25T00:01:00.000Z");

import { parseModelSpec, formatModelSpec, ModelSpecError } from "../../tools/dsh-bridge/src/model-spec.js";

mock.module("../../tools/dsh-bridge/src/index.js", () => ({
  parseModelSpec,
  formatModelSpec,
  ModelSpecError,
  runDsh: runDshMock,
  startDsh: startDshMock,
  pollRun: pollRunMock,
  renewLease: renewLeaseMock,
  waitRun: waitRunMock,
  killRun: killRunMock,
  readRunOutput: readRunOutputMock,
  listRuns: listRunsMock,
  sendToRun: sendToRunMock,
  sweepRuns: sweepRunsMock,
  sessionIdOfRun: sessionIdOfRunMock,
  ownRunIds: ownRunIdsMock,
}));

// Герметичность роли @dsh: без opts тул зовёт resolveRoleModel(ctx) без agentDir —
// резолвер внутри падает на getAgentDir() из @oh-my-pi/pi-coding-agent, т.е. на РЕАЛЬНЫЙ
// ~/.omp/agent владельца машины (см. extensions/dsh-task/role-model.ts). Подменяем сам
// getAgentDir на управляемый тестами каталог: по умолчанию — пустой temp-dir (эквивалент
// чистой машины без config.yml), тест роли ниже временно наводит testAgentDir на свой
// fixture-каталог и возвращает дефолт в finally.
// Единственный runtime (не type-only) экспорт @oh-my-pi/pi-coding-agent в графе импортов
// этого файла — getAgentDir из role-model.ts; relay.ts/dvibe.ts/ui.ts/index.ts берут из
// пакета только `import type`, которые стираются при компиляции и мока не требуют.
const defaultTestAgentDir = await mkdtemp(join(tmpdir(), "omp-agent-default-"));
let testAgentDir = defaultTestAgentDir;
mock.module("@oh-my-pi/pi-coding-agent", () => ({
  getAgentDir: () => testAgentDir,
}));
afterAll(async () => {
  await rm(defaultTestAgentDir, { recursive: true, force: true });
});

const dshTaskMod = await import("./index.ts");
const { default: dshTaskExtension } = dshTaskMod;
const relayMod = (await import("./relay.ts")) as unknown as Record<string, unknown>;

function makePi() {
  const sent: Array<{ payload: unknown; opts: unknown }> = [];
  const tools: Record<string, unknown> = {};
  const handlers: Record<string, unknown[]> = {};
  let activeTools: string[] = [];
  let zodVal: unknown = (globalThis as unknown as { __relayZod?: unknown }).__relayZod ?? null;
  const pi: unknown = {
    sendMessage(payload: unknown, opts: unknown) {
      (sent as Array<{ payload: unknown; opts: unknown }>).push({ payload, opts });
    },
    registerTool(def: unknown) {
      (tools as Record<string, unknown>)[(def as { name: string }).name] = def;
    },
    registerCommand() {},
    on(event: string, handler: unknown) {
      const byEvent = handlers as Record<string, unknown[]>;
      if (!byEvent[event]) byEvent[event] = [];
      byEvent[event].push(handler);
    },
    getActiveTools() {
      return activeTools;
    },
    async setActiveTools(v: string[]) {
      activeTools = v as string[];
    },
    get zod() {
      return zodVal as never;
    },
    set zod(v: unknown) {
      zodVal = v;
    },
    _sent: sent,
    _tools: tools,
    _handlers: handlers,
  };
  return { pi, sent, tools, handlers };
}

async function loadZod(pi: unknown): Promise<void> {
  const zodMod = await import("@oh-my-pi/omptype/zod");
  const z =
    (zodMod as unknown as { z?: unknown; default?: unknown }).z ??
    (zodMod as unknown as { default?: unknown }).default ??
    zodMod;
  (pi as unknown as { zod: unknown }).zod = z;
  (globalThis as unknown as { __relayZod?: unknown }).__relayZod = z;
}

function resetRelay() {
  const r = relayMod as unknown as { __resetForTest?: () => void; resetForTest?: () => void };
  if (typeof r.__resetForTest === "function") r.__resetForTest();
  else if (typeof r.resetForTest === "function") r.resetForTest();
  pollRunMock.mockClear();
  pollRunMock.mockReset();
  pollRunMock.mockImplementation(async (_runId: string, _opts: unknown) => ({
    runId: "run-1",
    state: "running" as const,
    envelope: null,
    exitCode: null,
  }));
  startDshMock.mockClear();
  listRunsMock.mockClear();
  renewLeaseMock.mockClear();
  // ensure listRuns returns empty by default for next test unless overridden
}

describe("relay: need_input", () => {
  beforeEach(resetRelay);

  it("после watchRun и тика с need_input — ровно одно сообщение irc:incoming с вопросом", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const rm = relayMod as unknown as { rememberPi?: (pi: unknown) => void; setPi?: (pi: unknown) => void };
    if (typeof rm.rememberPi === "function") rm.rememberPi(pi);
    else if (typeof rm.setPi === "function") rm.setPi(pi);

    const watch = relayMod as unknown as { watchRun: (id: string, label: string) => void };
    watch.watchRun("run-1", "worker-a");

    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-1",
      state: "need_input" as const,
      envelope: {
        v: 1,
        runId: "run-1",
        sessionId: "sess-1",
        status: "need_input",
        question: "что делать?",
        model: { provider: "p", model: "m" },
      },
      exitCode: null,
    }));

    const tickFn = relayMod as unknown as { __tickForTest?: () => Promise<void>; tickForTest?: () => Promise<void> };
    if (typeof tickFn.__tickForTest === "function") await tickFn.__tickForTest();
    else if (typeof tickFn.tickForTest === "function") await tickFn.tickForTest();
    else await new Promise((r) => setTimeout(r, 1200));

    expect(sent.length).toBe(1);
    const entry = sent[0] as unknown as {
      payload: {
        customType: string;
        details: { from: string };
        content: string;
        display: boolean;
        attribution: string;
      };
      opts: unknown;
    };
    expect(entry.payload.customType).toBe("irc:incoming");
    expect(entry.payload.details.from).toBe("worker-a");
    expect(entry.payload.content).toContain("что делать?");
    expect(entry.payload.content).toContain("worker-a");
    expect(entry.opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(entry.payload.display).toBe(true);
    expect(entry.payload.attribution).toBe("agent");

    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-1",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-1", sessionId: "sess-1", status: "need_input", question: "что делать?" },
      exitCode: null,
    }));
    if (typeof tickFn.__tickForTest === "function") await tickFn.__tickForTest();
    else if (typeof tickFn.tickForTest === "function") await tickFn.tickForTest();
    else await new Promise((r) => setTimeout(r, 1200));

    expect(sent.length).toBe(1);
  });
});

describe("relay: completed", () => {
  beforeEach(resetRelay);

  it("одно сообщение с result и строкой model:, ран снят с наблюдения", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const rm = relayMod as unknown as { rememberPi?: (pi: unknown) => void; setPi?: (pi: unknown) => void };
    if (typeof rm.rememberPi === "function") rm.rememberPi(pi);
    else if (typeof rm.setPi === "function") rm.setPi(pi);

    const watch = relayMod as unknown as { watchRun: (id: string, label: string) => void };
    watch.watchRun("run-2", "worker-b");

    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-2",
      state: "completed" as const,
      envelope: {
        v: 1,
        runId: "run-2",
        sessionId: "sess-2",
        status: "completed",
        result: "готово",
        model: { provider: "p", model: "m" },
      },
      exitCode: 0,
    }));

    const tickFn = relayMod as unknown as { __tickForTest?: () => Promise<void>; tickForTest?: () => Promise<void> };
    if (typeof tickFn.__tickForTest === "function") await tickFn.__tickForTest();
    else if (typeof tickFn.tickForTest === "function") await tickFn.tickForTest();
    else await new Promise((r) => setTimeout(r, 1200));

    expect(sent.length).toBe(1);
    const entry = sent[0] as unknown as { payload: { content: string } };
    expect(entry.payload.content).toContain("готово");
    expect(entry.payload.content).toContain("model:");

    // П.B: терминальный анонс держит ран под наблюдением, пока доставка не подтверждена
    // квитанцией message_start ровно на наш payload (П.H). Имитируем её.
    ackDelivery(sent);

    pollRunMock.mockClear();
    if (typeof tickFn.__tickForTest === "function") await tickFn.__tickForTest();
    else if (typeof tickFn.tickForTest === "function") await tickFn.tickForTest();
    else await new Promise((r) => setTimeout(r, 200));
    const callsForRun2 = (pollRunMock.mock.calls as unknown[]).filter((c) => (c as unknown[])[0] === "run-2");
    expect(callsForRun2.length).toBe(0);
  });
});

describe("relay: чужой ран", () => {
  beforeEach(resetRelay);

  it("ран из listRuns без watchRun — ноль сообщений", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const rm = relayMod as unknown as { rememberPi?: (pi: unknown) => void; setPi?: (pi: unknown) => void };
    if (typeof rm.rememberPi === "function") rm.rememberPi(pi);
    else if (typeof rm.setPi === "function") rm.setPi(pi);

    pollRunMock.mockImplementation(async () => ({
      runId: "foreign-run",
      state: "need_input" as const,
      envelope: { v: 1, runId: "foreign-run", sessionId: null, status: "need_input", question: "чужой вопрос" },
      exitCode: null,
    }));

    const tickFn = relayMod as unknown as { __tickForTest?: () => Promise<void>; tickForTest?: () => Promise<void> };
    if (typeof tickFn.__tickForTest === "function") await tickFn.__tickForTest();
    else if (typeof tickFn.tickForTest === "function") await tickFn.tickForTest();
    else await new Promise((r) => setTimeout(r, 400));

    expect(sent.length).toBe(0);
  });
});

describe("dsh_answer", () => {
  beforeEach(resetRelay);

  it("по label резолвит runId, зовёт startDsh с resumeFromRunId и той же меткой", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    expect(tool).toBeDefined();

    // set mocks AFTER beforeEach's mockClear
    listRunsMock.mockImplementation(async () => ({
      "run-10": {
        pid: 1,
        pgid: 1,
        dshSessionId: null,
        state: "need_input",
        startedAt: new Date().toISOString(),
        label: "my-label",
      },
    }));

    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-run-1", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });

    const res = (await tool.execute("c-1", { label: "my-label", answer: "да, делаем так" }, undefined, undefined, {
      cwd: "/tmp",
    })) as unknown as { content: Array<{ text: string }> };

    expect(captured).not.toBeNull();
    const cap = captured as unknown as { resumeFromRunId: string; label: string; taskFile: string };
    expect(cap.resumeFromRunId).toBe("run-10");
    expect(cap.label).toBe("my-label");
    expect(typeof cap.taskFile).toBe("string");
    expect(res.content[0].text).toContain("answered");
    expect(res.content[0].text).toContain("run-10");
    expect(res.content[0].text).toContain("new-run-1");
  });

  it("ошибка при ни одном из runId/label; оба вместе — валидно (П.E)", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...args: unknown[]) => Promise<unknown> };

    const r1 = (await tool.execute("c-2", { answer: "x" }, undefined, undefined, { cwd: "/tmp" })) as unknown as {
      isError: boolean;
    };
    expect(r1.isError).toBe(true);

    // Смоук 2026-08-26: сообщение relay подсказывает runId, директива учит метке — модель
    // предсказуемо передаёт оба. Раньше это была ошибка контракта, теперь валидная комбинация.
    startDshMock.mockImplementation(async () => ({
      runId: "new-run-both",
      pid: 1,
      pgid: 1,
      logFile: "/tmp/x",
      startedAt: new Date().toISOString(),
    }));
    const r2 = (await tool.execute("c-3", { runId: "a", label: "b", answer: "x" }, undefined, undefined, {
      cwd: "/tmp",
    })) as unknown as { isError?: boolean };
    expect(r2.isError).not.toBe(true);
  });

  it("оба параметра: цель по runId, метка нового рана = label (П.E)", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...args: unknown[]) => Promise<unknown> };

    // Под этой меткой relay знает ДРУГОЙ ран — цель обязана определяться по runId, не по label
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-other", "both-label");

    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-run-both2", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });

    const res = (await tool.execute(
      "c-4",
      { runId: "run-target", label: "both-label", answer: "ok" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    )) as unknown as { content: Array<{ text: string }>; details: { label: string | null } };
    const cap = captured as unknown as { resumeFromRunId: string; label?: string };
    expect(cap.resumeFromRunId).toBe("run-target"); // НЕ "run-other" из label-резолва
    expect(cap.label).toBe("both-label"); // метка нового рана — из параметра label
    expect(res.details.label).toBe("both-label");
    expect(res.content[0].text).toContain("run-target");
  });

  it("наследование модели — resolveRoleModel использован при отсутствии явной модели", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...args: unknown[]) => Promise<unknown> };

    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-run-2", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });

    const fakeCtx: unknown = {
      cwd: "/tmp",
      models: {
        resolve: (spec: string) =>
          spec === "@dsh" ? { provider: "omniroute", id: "metac/muse-spark-1.2-contributor" } : undefined,
      },
      model: undefined,
    };

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    writeFileSync(
      join(dir, "config.yml"),
      `modelRoles:\n  dsh: omniroute/metac/muse-spark-1.2-contributor:high\n`,
      "utf8",
    );
    testAgentDir = dir; // тул зовёт resolveRoleModel(ctx) без opts — направляем мок getAgentDir на фикстуру
    try {
      const roleMod = (await import("./role-model.ts")) as unknown as {
        resolveRoleModel: (ctx: unknown, opts: unknown) => unknown;
      };
      const expected = roleMod.resolveRoleModel(fakeCtx, { agentDir: dir });
      await tool.execute("c-4", { runId: "run-99", answer: "ok" }, undefined, undefined, fakeCtx);
      const cap = captured as unknown as { model: unknown };
      expect(cap.model).toEqual(expected);
    } finally {
      testAgentDir = defaultTestAgentDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1: relay продлевает аренду с cadence 60s", () => {
  beforeEach(resetRelay);
  it("протухшая аренда продлевается; тик подряд — нет; окно cadence держит и для completed", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    const watch = relayMod as unknown as { watchRun: (id: string, label: string) => void };
    watch.watchRun("run-lease", "lease-worker");
    const setLast = relayMod as unknown as { __setLastRenewedAtForTest?: (id: string, ts: number) => void };
    if (typeof setLast.__setLastRenewedAtForTest === "function")
      setLast.__setLastRenewedAtForTest("run-lease", Date.now() - 61_000);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-lease",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(renewLeaseMock.mock.calls.length).toBe(1);
    expect((renewLeaseMock.mock.calls[0] as unknown[])[0]).toBe("run-lease");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-lease",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(renewLeaseMock.mock.calls.length).toBe(1);
    // Продление не смотрит на state (state известен только после pollRun) — completed тут не
    // продлевается ровно потому, что окно cadence ещё не истекло.
    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-lease",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-lease", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(renewLeaseMock.mock.calls.length).toBe(1);
    // cleanup: P1 left pollRunMock as permanent running mock, reset to default
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("П.A: need_input остаётся под наблюдением до закрытия (Esc-урок смоука 2026-08-26)", () => {
  beforeEach(resetRelay);

  it("контракт: NEED_INPUT_REANNOUNCE_MS = 120_000", () => {
    expect((relayMod as unknown as { NEED_INPUT_REANNOUNCE_MS: number }).NEED_INPUT_REANNOUNCE_MS).toBe(120_000);
  });

  it("вопрос отправлен → ран НЕ снят; повторный тик сразу — без дубля", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-need", "need-worker");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-need",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-need", sessionId: null, status: "need_input", question: "q" },
      exitCode: null,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    // «поставлено в очередь» ≠ «доставлено»: Esc теряет очередь followUp, поэтому вопрос
    // держим под наблюдением до dsh_answer (unwatchRun), а не до факта отправки.
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-need"),
    ).toBe(true);
    await tick();
    expect(sent.length).toBe(1);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("сдвиг времени ≥ NEED_INPUT_REANNOUNCE_MS → повторный анонс тем же текстом; метка обновлена", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-need2", "need2");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-need2",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-need2", sessionId: null, status: "need_input", question: "который час?" },
      exitCode: null,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    // время двигаем сеттером (по образцу __setLastRenewedAtForTest) — никаких реальных sleep
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, key: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-need2", "need_input", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(2);
    const first = (sent[0] as unknown as { payload: { content: string } }).payload.content;
    const second = (sent[1] as unknown as { payload: { content: string } }).payload.content;
    expect(second).toBe(first); // дедупликация смыслом: дословный повтор
    await tick(); // повтор обновил метку времени — немедленный тик молчит
    expect(sent.length).toBe(2);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("unwatchRun (успешный dsh_answer) снимает ран: тики больше не опрашивают", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-answered", "answered");
    (relayMod as unknown as { unwatchRun: (id: string) => void }).unwatchRun("run-answered");
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-answered"),
    ).toBe(false);
    expect((relayMod as unknown as { __hasTimerForTest: () => boolean }).__hasTimerForTest()).toBe(false);
    pollRunMock.mockClear();
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(pollRunMock.mock.calls.length).toBe(0);
  });

  it("need_input → killed: ветка error анонсирует «killed» (ключи анонсов разные) и закрывается ходом", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ni-err", "ni-err");
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-ni-err",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-ni-err", sessionId: null, status: "need_input", question: "можно?" },
      exitCode: null,
    }));
    await tick();
    expect(sent.length).toBe(1);
    // dsh_kill: envelope становится error/killed, пока ран после вопроса всё ещё под наблюдением
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ni-err",
      state: "error" as const,
      envelope: {
        v: 1,
        runId: "run-ni-err",
        sessionId: null,
        status: "error",
        error: { code: "killed", message: "killed" },
      },
      exitCode: null,
    }));
    await tick();
    expect(sent.length).toBe(2);
    expect((sent[1] as unknown as { payload: { content: string } }).payload.content).toContain("killed");
    // терминальный анонс — под страховкой П.B: снятие по квитанции доставки (П.H)
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ni-err"),
    ).toBe(true);
    ackDelivery(sent);
    await tick();
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ni-err"),
    ).toBe(false);
    expect(sent.length).toBe(2);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("П.B: терминальная страховка — повтор, пока не начался ход", () => {
  beforeEach(resetRelay);

  it("контракт: TERMINAL_REANNOUNCE_MS = 120_000", () => {
    expect((relayMod as unknown as { TERMINAL_REANNOUNCE_MS: number }).TERMINAL_REANNOUNCE_MS).toBe(120_000);
  });

  it("completed анонсирован, хода не было, сдвиг ≥ TERMINAL_REANNOUNCE_MS → дословный повтор", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-term", "term");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-term",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-term", sessionId: "s-t", status: "completed", result: "готово" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    await tick(); // окно не истекло, хода не было — тишина, но ран под наблюдением
    expect(sent.length).toBe(1);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-term"),
    ).toBe(true);
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, key: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-term", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(2);
    expect((sent[1] as unknown as { payload: { content: string } }).payload.content).toBe(
      (sent[0] as unknown as { payload: { content: string } }).payload.content,
    );
    await tick(); // повтор перезапомнил метку времени и счётчик — немедленный тик молчит
    expect(sent.length).toBe(2);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("completed анонсирован, квитанция пришла → следующий тик снимает без повтора и без опроса", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-term2", "term2");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-term2",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-term2", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    ackDelivery(sent);
    pollRunMock.mockClear();
    await tick();
    expect(sent.length).toBe(1);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-term2"),
    ).toBe(false);
    // терминальный ран после анонса вообще не опрашивается — состояние не меняется
    expect(pollRunMock.mock.calls.length).toBe(0);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("квитанция без наблюдаемого рана и с мусорным payload — молчаливый no-op", () => {
    const note = (relayMod as unknown as { noteMessageDelivered: (m: unknown) => void }).noteMessageDelivered;
    expect(() => {
      note(null);
      note(undefined);
      note("строка");
      note({ role: "custom", customType: "irc:incoming" });
      note({ role: "custom", customType: "irc:incoming", details: { id: 42 } });
      note({ role: "custom", customType: "irc:incoming", details: { id: "нет такого рана", message: "x" } });
    }).not.toThrow();
  });

  it("анонс → ack до повтора → повтора нет (П.B и П.F не конфликтуют)", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-term3", "term3");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-term3",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-term3", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    // директор прочитал результат сам (dsh_wait) — ack снимает запись, повтору не из чего родиться
    (relayMod as unknown as { acknowledgeRun: (id: string, st: string) => void }).acknowledgeRun(
      "run-term3",
      "completed",
    );
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-term3"),
    ).toBe(false);
    await tick();
    expect(sent.length).toBe(1);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("П.F: acknowledgeRun — dsh_wait и relay не дублируют друг друга", () => {
  beforeEach(resetRelay);

  it("терминальный ран под наблюдением (до анонса) + ack → снят молча, тик не анонсирует", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ackt", "ackt");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ackt",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-ackt", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    (relayMod as unknown as { acknowledgeRun: (id: string, st: string) => void }).acknowledgeRun(
      "run-ackt",
      "completed",
    );
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ackt"),
    ).toBe(false);
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(0);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("need_input анонсирован + ack → остаётся под наблюдением, напоминание отложено на полный интервал", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ackq", "ackq");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ackq",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-ackq", sessionId: null, status: "need_input", question: "q?" },
      exitCode: null,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    // напоминание созрело, но директор только что прочитал вопрос сам (dsh_wait) — ack освежает метку
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, key: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-ackq", "need_input", Date.now() - 120_000);
    (relayMod as unknown as { acknowledgeRun: (id: string, st: string) => void }).acknowledgeRun(
      "run-ackq",
      "need_input",
    );
    await tick();
    expect(sent.length).toBe(1); // ре-анонса нет: директор видел вопрос только что
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ackq"),
    ).toBe(true); // вопрос всё ещё ждёт dsh_answer
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, key: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-ackq", "need_input", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(2); // полный интервал от ack прошёл — напоминание вернулось
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("need_input, relay ещё не анонсировал + ack → и первый анонс отложен (dsh_wait успел раньше)", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ackq2", "ackq2");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ackq2",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-ackq2", sessionId: null, status: "need_input", question: "q2?" },
      exitCode: null,
    }));
    (relayMod as unknown as { acknowledgeRun: (id: string, st: string) => void }).acknowledgeRun(
      "run-ackq2",
      "need_input",
    );
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(0); // директор уже видел вопрос — дубль сразу после dsh_wait был бы шумом
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, key: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-ackq2", "need_input", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(1); // но вопрос не потерян: напоминание пришло через полный интервал
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("ack неизвестного runId — no-op без ошибки", () => {
    expect(() =>
      (relayMod as unknown as { acknowledgeRun: (id: string, st: string) => void }).acknowledgeRun(
        "no-such-run",
        "completed",
      ),
    ).not.toThrow();
  });

  it("метки переживают ack — dsh_answer после dsh_wait работает", () => {
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      acknowledgeRun: (id: string, st: string) => void;
      resolveLabel: (l: string) => string | undefined;
      resolveLabelForRun: (id: string) => string | undefined;
    };
    relay.watchRun("run-ackl", "ack-label");
    relay.acknowledgeRun("run-ackl", "completed");
    expect(relay.resolveLabel("ack-label")).toBe("run-ackl");
    expect(relay.resolveLabelForRun("run-ackl")).toBe("ack-label");
  });

  it("dsh_wait с envelope зовёт ack (ран снят); таймаут ожидания наблюдение не трогает", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      __watchedForTest: () => Map<string, unknown>;
    };
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_wait as unknown as { execute: (...a: unknown[]) => Promise<unknown> };

    relay.watchRun("run-w", "w-label");
    waitRunMock.mockImplementation(async () => ({
      runId: "run-w",
      state: "completed" as const,
      envelope: { v: 1 as const, runId: "run-w", sessionId: "s-w", status: "completed" as const, result: "ok" },
      exitCode: 0,
    }));
    await tool.execute("c-w1", { runId: "run-w", waitMs: 0 }, undefined, undefined, { cwd: "/tmp" });
    expect(relay.__watchedForTest().has("run-w")).toBe(false);

    relay.watchRun("run-w2", "w2-label");
    waitRunMock.mockImplementation(async () => ({
      runId: "run-w2",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
    await tool.execute("c-w2", { runId: "run-w2", waitMs: 0 }, undefined, undefined, { cwd: "/tmp" });
    expect(relay.__watchedForTest().has("run-w2")).toBe(true);

    waitRunMock.mockImplementation(async (_runId: string, _opts: { waitMs: number }) => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("P3: lastRunByLabel и dsh_answer label-резолв", () => {
  beforeEach(resetRelay);
  it("две итерации с одной меткой → второй dsh_answer резюмит ВТОРОЙ ран", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      resolveLabel?: (l: string) => string | undefined;
    };
    relay.watchRun("run-10", "my-label");
    relay.watchRun("run-20", "my-label");
    expect(relay.resolveLabel?.("my-label")).toBe("run-20");
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    listRunsMock.mockImplementation(async () => ({
      "run-10": { pid: 1, pgid: 1, state: "need_input", startedAt: "2026-08-25T00:00:00.000Z", label: "my-label" },
      "run-20": { pid: 2, pgid: 2, state: "need_input", startedAt: "2026-08-25T00:01:00.000Z", label: "my-label" },
    }));
    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-30", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });
    const res = (await tool.execute("c-1", { label: "my-label", answer: "ok" }, undefined, undefined, {
      cwd: "/tmp",
    })) as unknown as { content: Array<{ text: string }> };
    expect((captured as unknown as { resumeFromRunId: string }).resumeFromRunId).toBe("run-20");
    expect(res.content[0].text).toContain("run-20");
  });
  it("запись выметена из реестра, но relay видел ран → резолв через relay-карту", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    const relay = relayMod as unknown as { watchRun: (id: string, l: string) => void };
    relay.watchRun("run-42", "evicted-label");
    listRunsMock.mockImplementation(async () => ({}));
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-99", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });
    const res = (await tool.execute("c-2", { label: "evicted-label", answer: "ok" }, undefined, undefined, {
      cwd: "/tmp",
    })) as unknown as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect((captured as unknown as { resumeFromRunId: string }).resumeFromRunId).toBe("run-42");
  });
  it("fallback listRuns выбирает самую новую запись (max startedAt), не first-match", async () => {
    const { pi } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    listRunsMock.mockImplementation(async () => ({
      "run-a": { pid: 1, pgid: 1, state: "need_input", startedAt: "2026-08-25T00:00:00.000Z", label: "fb-label" },
      "run-b": { pid: 2, pgid: 2, state: "need_input", startedAt: "2026-08-25T00:05:00.000Z", label: "fb-label" },
      "run-c": { pid: 3, pgid: 3, state: "need_input", startedAt: "2026-08-25T00:02:00.000Z", label: "fb-label" },
    }));
    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "new-fb", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });
    await tool.execute("c-3", { label: "fb-label", answer: "ok" }, undefined, undefined, { cwd: "/tmp" });
    expect((captured as unknown as { resumeFromRunId: string }).resumeFromRunId).toBe("run-b");
  });
});

describe("P4: killed/timeout через error.code", () => {
  beforeEach(resetRelay);
  it("error code killed → 'killed', timeout → 'failed: error [timeout]', оба снимаются после подтверждения ходом", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-killed", "killed-worker");
    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-killed",
      state: "error" as const,
      envelope: {
        v: 1,
        runId: "run-killed",
        sessionId: null,
        status: "error",
        error: { code: "killed", message: "killed" },
      },
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(1);
    expect((sent[0] as unknown as { payload: { content: string } }).payload.content).toContain("killed");
    expect((sent[0] as unknown as { payload: { content: string } }).payload.content).not.toContain("failed");
    // П.B: терминальный анонс держит ран до подтверждения квитанцией доставки (П.H)
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-killed"),
    ).toBe(true);
    ackDelivery(sent);
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-killed"),
    ).toBe(false);

    const { pi: pi2, sent: sent2 } = makePi();
    await loadZod(pi2);
    (dshTaskExtension as (pi: unknown) => void)(pi2);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi2);
    (relayMod as unknown as { __resetForTest: () => void }).__resetForTest();
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi2);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-timeout", "to-worker");
    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-timeout",
      state: "error" as const,
      envelope: {
        v: 1,
        runId: "run-timeout",
        sessionId: null,
        status: "error",
        error: { code: "timeout", message: "deadline" },
      },
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent2.length).toBe(1);
    expect((sent2[0] as unknown as { payload: { content: string } }).payload.content).toContain("failed");
    expect((sent2[0] as unknown as { payload: { content: string } }).payload.content).toContain("timeout");
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-timeout"),
    ).toBe(true);
    ackDelivery(sent2);
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-timeout"),
    ).toBe(false);
  });
});

describe("P5: потеря события при throw sendMessage и реентерабельность", () => {
  beforeEach(resetRelay);
  it("первый sendMessage бросает → событие не помечено; следующий тик доставляет ровно один раз", async () => {
    let callCount = 0;
    const sent: Array<{ payload: unknown; opts: unknown }> = [];
    const pi = {
      sendMessage(payload: unknown, opts: unknown) {
        callCount++;
        if (callCount === 1) throw new Error("boom");
        sent.push({ payload, opts });
      },
      registerTool(def: unknown) {
        (this as unknown as { _tools: Record<string, unknown> })._tools[(def as { name: string }).name] = def;
      },
      registerCommand() {},
      on() {},
      getActiveTools() {
        return [] as string[];
      },
      async setActiveTools() {},
      get zod() {
        return (globalThis as unknown as { __relayZod: unknown }).__relayZod as never;
      },
      set zod(v: unknown) {
        (globalThis as unknown as { __relayZod: unknown }).__relayZod = v;
      },
      _tools: {} as Record<string, unknown>,
    } as unknown as { _tools: Record<string, unknown> } & {
      sendMessage: (p: unknown, o: unknown) => void;
      registerTool: (d: unknown) => void;
      registerCommand: () => void;
      on: () => void;
      getActiveTools: () => string[];
      setActiveTools: () => Promise<void>;
      zod: unknown;
    };
    await loadZod(pi as unknown as never);
    (dshTaskExtension as (pi: unknown) => void)(pi as unknown as never);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi as unknown as never);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-p5", "p5-worker");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-p5",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-p5", sessionId: null, status: "need_input", question: "q5" },
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(0);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-p5"),
    ).toBe(true);
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(1);
  });
});

describe("P6: канал недоступен (sendMessage отсутствует) — событие не теряется", () => {
  beforeEach(resetRelay);
  it("нет sendMessage → ран остаётся под наблюдением и не помечен; после появления канала доставка ровно один раз", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);

    // канал закрыт: у pi нет sendMessage (ранняя фаза старта / другой хост расширения)
    const realSend = (pi as unknown as { sendMessage: unknown }).sendMessage;
    (pi as unknown as { sendMessage: unknown }).sendMessage = undefined;

    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-mute", "mute-worker");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-mute",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-mute", sessionId: null, status: "completed", result: "тихо" },
      exitCode: 0,
    }));

    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(0);
    const watchedMap = (
      relayMod as unknown as { __watchedForTest: () => Map<string, { announcedAt: Map<string, number> }> }
    ).__watchedForTest();
    expect(watchedMap.has("run-mute")).toBe(true);
    expect(watchedMap.get("run-mute")?.announcedAt.size).toBe(0);

    // канал открылся — событие должно доехать, и ровно один раз
    (pi as unknown as { sendMessage: unknown }).sendMessage = realSend;
    await tick();
    expect(sent.length).toBe(1);
    expect((sent[0] as unknown as { payload: { content: string } }).payload.content).toContain("тихо");
    // П.B: терминальный анонс не снимает ран сам — подтверждение приходит квитанцией (П.H)
    expect(watchedMap.has("run-mute")).toBe(true);
    await tick();
    expect(sent.length).toBe(1);
    ackDelivery(sent);
    await tick();
    expect(watchedMap.has("run-mute")).toBe(false);
    expect(sent.length).toBe(1);

    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("P7: __resetForTest чистит lastRunByLabel", () => {
  beforeEach(resetRelay);
  it("после reset label из прошлого теста больше не резолвится", () => {
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      resolveLabel: (l: string) => string | undefined;
      __resetForTest: () => void;
    };
    relay.watchRun("run-leak", "leaky-label");
    expect(relay.resolveLabel("leaky-label")).toBe("run-leak");
    relay.__resetForTest();
    expect(relay.resolveLabel("leaky-label")).toBeUndefined();
  });
});

describe("П.1: смена сессии внутри процесса сбрасывает состояние relay", () => {
  beforeEach(resetRelay);

  // OMP умеет менять сессию БЕЗ перезапуска процесса (session_switch/session_branch),
  // а состояние relay модульное — без сброса событие рана СТАРОЙ сессии уехало бы в
  // transcript НОВОЙ, а resolveLabel отдал бы там метку из прошлой сессии.
  for (const event of ["session_switch", "session_branch"] as const) {
    it(`${event}: тик не опрашивает раны, метка не резолвится, таймер остановлен`, async () => {
      const { pi, sent, handlers } = makePi();
      await loadZod(pi);
      (dshTaskExtension as (pi: unknown) => void)(pi);
      (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);

      const relay = relayMod as unknown as {
        watchRun: (id: string, l: string) => void;
        resolveLabel: (l: string) => string | undefined;
        resolveLabelForRun: (id: string) => string | undefined;
        __watchedForTest: () => Map<string, unknown>;
        __hasTimerForTest: () => boolean;
      };
      relay.watchRun("run-switch", "switch-label");
      expect(relay.__hasTimerForTest()).toBe(true);
      expect(relay.resolveLabel("switch-label")).toBe("run-switch");
      killRunMock.mockClear();

      const handler = (handlers[event] ?? [])[0] as ((e: unknown, c?: unknown) => unknown) | undefined;
      expect(typeof handler).toBe("function");
      await (handler as (e: unknown, c?: unknown) => unknown)(
        { type: event, reason: "resume", previousSessionFile: "/old.jsonl" },
        {},
      );

      expect(relay.__watchedForTest().size).toBe(0);
      expect(relay.__hasTimerForTest()).toBe(false);
      expect(relay.resolveLabel("switch-label")).toBeUndefined();
      expect(relay.resolveLabelForRun("run-switch")).toBeUndefined();

      // Тик после сброса не должен ни опрашивать раны, ни слать что-либо в новую сессию.
      pollRunMock.mockImplementation(async () => ({
        runId: "run-switch",
        state: "need_input" as const,
        envelope: { v: 1, runId: "run-switch", sessionId: null, status: "need_input", question: "старый вопрос" },
        exitCode: null,
      }));
      await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
      expect(pollRunMock.mock.calls.length).toBe(0);
      expect(sent.length).toBe(0);

      // Раны при смене сессии НЕ убиваем (в отличие от session_shutdown): процесс жив,
      // они остаются в реестре и доступны через dsh_list.
      expect(killRunMock.mock.calls.length).toBe(0);

      pollRunMock.mockImplementation(async () => ({
        runId: "run-1",
        state: "running" as const,
        envelope: null,
        exitCode: null,
      }));
    });
  }
});

describe("П.1: сброс во время in-flight тика", () => {
  beforeEach(resetRelay);

  it("pollRun висел на момент сброса → его событие не уезжает в новую сессию", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      resetForSessionSwitch: () => void;
      __tickForTest: () => Promise<void>;
    };
    relay.watchRun("run-inflight", "inflight-label");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    pollRunMock.mockImplementation(async () => {
      await gate;
      return {
        runId: "run-inflight",
        state: "need_input" as const,
        envelope: {
          v: 1,
          runId: "run-inflight",
          sessionId: null,
          status: "need_input",
          question: "вопрос старой сессии",
        },
        exitCode: null,
      };
    });

    const inFlight = relay.__tickForTest();
    // сессия сменилась, пока тик висел на await pollRun
    relay.resetForSessionSwitch();
    (release as () => void)();
    await inFlight;

    expect(sent.length).toBe(0);

    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("П.2: dsh_answer по runId берёт метку из relay, когда реестр уже выметен", () => {
  beforeEach(resetRelay);

  it("вопрос доставлен и ран снят с наблюдения, реестр пуст → новый ран получает ИСХОДНУЮ метку", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    const relay = relayMod as unknown as {
      watchRun: (id: string, l: string) => void;
      resolveLabel: (l: string) => string | undefined;
    };

    relay.watchRun("run-q", "q-label");
    pollRunMock.mockImplementationOnce(async () => ({
      runId: "run-q",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-q", sessionId: null, status: "need_input", question: "продолжать?" },
      exitCode: null,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(1);
    // relay сам предлагает отвечать по runId — значит именно этот путь обязан сохранять метку
    expect((sent[0] as unknown as { payload: { content: string } }).payload.content).toContain(
      "dsh_answer runId=run-q",
    );

    // reapOrphans вымел терминальную запись из реестра (≤30с после вопроса)
    listRunsMock.mockImplementation(async () => ({}));

    let captured: unknown = null;
    startDshMock.mockImplementation(async (opts: unknown) => {
      captured = opts;
      return { runId: "run-q2", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: new Date().toISOString() };
    });

    const tools = (pi as unknown as { _tools: Record<string, unknown> })._tools;
    const tool = tools.dsh_answer as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    const res = (await tool.execute("c-1", { runId: "run-q", answer: "да" }, undefined, undefined, {
      cwd: "/tmp",
    })) as unknown as { details: { label: string | null } };

    expect((captured as unknown as { label?: string }).label).toBe("q-label");
    expect(res.details.label).toBe("q-label");
    // П.A: вопрос закрыт именно успешным ответом — dsh_answer снимает СТАРЫЙ ран с наблюдения
    // (unwatchRun), а не факт отправки сообщения когда-то раньше.
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-q"),
    ).toBe(false);
    // цепочка меток не рвётся: следующий вопрос придёт как ⟨q-label⟩, а не ⟨shortId⟩
    expect(relay.resolveLabel("q-label")).toBe("run-q2");
  });
});

// П.H (раунд 3, находка Codex P1): подтверждение доставки — не «начался ход», а квитанция
// message_start с ровно нашим payload. followUp, влитый в УЖЕ РАБОТАЮЩИЙ agent loop
// (agent-loop.ts: getFollowUpMessages → pendingMessages → continue), не проходит через
// before_agent_start вовсе — старая эвристика в этом пути никогда не подтверждалась и
// повторяла прочитанный результат каждые 120 с.
// Форма квитанции — как у ЖИВОГО сообщения, без поля role. Раньше здесь синтезировался
// role:"custom", которого в реальности нет: sendCustomMessage собирает сообщение из
// customType/content/display/details/attribution, и в transcript оно ложится как
// {type:"custom_message", ...}. Из-за выдуманного поля вся обвязка квитанции зеленела,
// пока в production ни одна квитанция не засчитывалась (см. noteMessageDelivered).
function deliveryOf(sentList: Array<{ payload: unknown; opts: unknown }>, idx = sentList.length - 1): unknown {
  const p = (sentList[idx] as unknown as { payload: { customType: string; details: unknown } }).payload;
  return { customType: p.customType, details: p.details };
}

function ackDelivery(sentList: Array<{ payload: unknown; opts: unknown }>, idx = sentList.length - 1): void {
  (relayMod as unknown as { noteMessageDelivered: (m: unknown) => void }).noteMessageDelivered(
    deliveryOf(sentList, idx),
  );
}

describe("П.H: квитанция доставки (message_start), а не факт начала хода", () => {
  beforeEach(resetRelay);

  it("контракт: MAX_ANNOUNCE_ATTEMPTS = 3", () => {
    expect((relayMod as unknown as { MAX_ANNOUNCE_ATTEMPTS: number }).MAX_ANNOUNCE_ATTEMPTS).toBe(3);
  });

  it("терминальный анонс + квитанция ровно нашего сообщения → ран снят, повтора нет", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ack", "ack");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ack",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-ack", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    ackDelivery(sent);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ack"),
    ).toBe(false);
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, k: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-ack", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(1);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("РЕГРЕСС живой находки: квитанция БЕЗ поля role засчитывается (у живого сообщения его нет)", async () => {
    // Дефект, найденный на живой сессии: директор получал каждый результат воркера
    // ТРИЖДЫ. noteMessageDelivered требовал role === "custom", а message_start несёт
    // сообщение без поля role вовсе — ранний return, квитанция не засчитывалась
    // никогда, relay повторял анонс до MAX_ANNOUNCE_ATTEMPTS. Все тесты при этом были
    // зелёными: их хелпер синтезировал role сам. Здесь payload собирается ровно из
    // того, что relay реально отправил, без единого дописанного поля.
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-norole", "norole");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-norole",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-norole", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);

    const payload = (sent[0] as unknown as { payload: Record<string, unknown> }).payload;
    expect("role" in payload, "relay не кладёт role — тест обязан работать с этой формой").toBe(false);
    (relayMod as unknown as { noteMessageDelivered: (m: unknown) => void }).noteMessageDelivered(payload);

    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-norole"),
      "квитанция засчитана — ран снят с наблюдения",
    ).toBe(false);
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, k: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-norole", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length, "повтора быть не должно").toBe(1);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("РЕГРЕСС находки P1: ход агента без квитанции не считается доставкой — повтор по таймеру", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-noack", "noack");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-noack",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-noack", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    await tick();
    expect(sent.length).toBe(1);
    // Эмулируем «ход начался, но наше сообщение в него не попало» — Esc-путь: очередь followUp
    // стрендится, message_start по нашему payload не приходит.
    const handlers = (pi as unknown as { _handlers: Record<string, Array<(e: unknown) => unknown>> })._handlers;
    for (const h of handlers.message_start ?? [])
      await h({ type: "message_start", message: { role: "user", content: "человек написал сам" } });
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-noack"),
    ).toBe(true);
    (
      relayMod as unknown as { __setAnnouncedAtForTest: (id: string, k: string, ts: number) => void }
    ).__setAnnouncedAtForTest("run-noack", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(2);
    expect((sent[1] as unknown as { payload: { content: string } }).payload.content).toBe(
      (sent[0] as unknown as { payload: { content: string } }).payload.content,
    );
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("index.ts подписан на message_start и проводит сообщение в relay", async () => {
    const { pi, sent, handlers } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    expect((handlers.message_start ?? []).length).toBe(1);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-wire", "wire");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-wire",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-wire", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(1);
    const h = (handlers.message_start as Array<(e: unknown) => unknown>)[0];
    await h({ type: "message_start", message: deliveryOf(sent) });
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-wire"),
    ).toBe(false);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("квитанция чужого рана и чужого customType не закрывает наш", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-mine", "mine");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-mine",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-mine", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    await (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest();
    expect(sent.length).toBe(1);
    const note = (relayMod as unknown as { noteMessageDelivered: (m: unknown) => void }).noteMessageDelivered;
    const mine = deliveryOf(sent) as { customType: string; details: { id: string; message: string } };
    note({ role: "custom", customType: "irc:incoming", details: { id: "run-other", message: mine.details.message } });
    note({ role: "custom", customType: "dsh_worker", details: mine.details });
    note({ role: "user", content: mine.details.message });
    // тот же ран, но текст другого события — квитанция не наша
    note({ role: "custom", customType: "irc:incoming", details: { id: "run-mine", message: "чужой текст" } });
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-mine"),
    ).toBe(true);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("предохранитель: без квитанций анонс повторяется MAX_ANNOUNCE_ATTEMPTS раз и ран снимается", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-cap", "cap");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-cap",
      state: "completed" as const,
      envelope: { v: 1, runId: "run-cap", sessionId: null, status: "completed", result: "ok" },
      exitCode: 0,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    const age = (relayMod as unknown as { __setAnnouncedAtForTest: (id: string, k: string, ts: number) => void })
      .__setAnnouncedAtForTest;
    await tick();
    expect(sent.length).toBe(1);
    age("run-cap", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(2);
    age("run-cap", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(3);
    age("run-cap", "completed", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(3);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-cap"),
    ).toBe(false);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });

  it("need_input с подтверждённой доставкой не напоминает; без квитанции — напоминает", async () => {
    const { pi, sent } = makePi();
    await loadZod(pi);
    (dshTaskExtension as (pi: unknown) => void)(pi);
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ni-ack", "ni-ack");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ni-ack",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-ni-ack", sessionId: null, status: "need_input", question: "сколько?" },
      exitCode: null,
    }));
    const tick = (relayMod as unknown as { __tickForTest: () => Promise<void> }).__tickForTest;
    const age = (relayMod as unknown as { __setAnnouncedAtForTest: (id: string, k: string, ts: number) => void })
      .__setAnnouncedAtForTest;
    await tick();
    expect(sent.length).toBe(1);
    ackDelivery(sent);
    // вопрос уже в контексте директора — напоминание было бы шумом, а ран остаётся под
    // наблюдением: закрывает его только успешный dsh_answer (unwatchRun).
    age("run-ni-ack", "need_input", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(1);
    expect(
      (relayMod as unknown as { __watchedForTest: () => Map<string, unknown> }).__watchedForTest().has("run-ni-ack"),
    ).toBe(true);

    (relayMod as unknown as { __resetForTest: () => void }).__resetForTest();
    (relayMod as unknown as { rememberPi?: (pi: unknown) => void }).rememberPi?.(pi);
    (relayMod as unknown as { watchRun: (id: string, l: string) => void }).watchRun("run-ni-lost", "ni-lost");
    pollRunMock.mockImplementation(async () => ({
      runId: "run-ni-lost",
      state: "need_input" as const,
      envelope: { v: 1, runId: "run-ni-lost", sessionId: null, status: "need_input", question: "сколько?" },
      exitCode: null,
    }));
    await tick();
    const before = sent.length;
    age("run-ni-lost", "need_input", Date.now() - 120_000);
    await tick();
    expect(sent.length).toBe(before + 1);
    pollRunMock.mockImplementation(async () => ({
      runId: "run-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    }));
  });
});

describe("guard нативного типа irc:incoming", () => {
  it("строка irc:incoming есть в OMP исходниках", async () => {
    const src = await readFile(
      "node_modules/@oh-my-pi/pi-coding-agent/src/modes/utils/transcript-render-helpers.ts",
      "utf8",
    );
    expect(
      src.includes('"irc:incoming"') || src.includes("'irc:incoming'"),
      "OMP переименовал customType — обнови relay.ts и этот тест",
    ).toBe(true);
  });
});
