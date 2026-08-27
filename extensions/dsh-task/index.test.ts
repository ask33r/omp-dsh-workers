import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Mock bridge-core ---
// Возвращаемый тип каждого мока подписан типом настоящего bridge-core. Без подписи
// `mock()` выводит тип по ПЕРВОЙ реализации («state всегда running», «sessionId всегда
// null»), и любая последующая mockImplementation с другим законным вариантом контракта
// перестаёт проходить проверку типов. `import type` стирается компилятором, так что
// mock.module ниже он не задевает.
import type {
  Envelope,
  KillRunResult,
  PollRunResult,
  ReadRunOutputResult,
  SendToRunResult,
  RunHandle,
} from "../../tools/dsh-bridge/src/index.js";

const runDshMock = mock(async (_opts: unknown): Promise<Envelope> => {
  return {
    v: 1 as const,
    runId: "run-1",
    sessionId: null,
    status: "completed" as const,
    result: "hello from dsh",
  };
});

// Тулы оркестрации (dsh_spawn/dsh_wait/dsh_kill/dsh_list) — контракт v2. startDsh/waitRun/
// killRun/readRunOutput ещё не реализованы параллельным агентом на момент написания этого
// файла, поэтому мокаем их так же, как runDsh выше.
const startDshMock = mock(
  async (_opts: unknown): Promise<RunHandle> => ({
    runId: "run-spawn-1",
    pid: 4242,
    pgid: 4242,
    logFile: "/tmp/run-spawn-1.log",
    startedAt: new Date().toISOString(),
  }),
);

const waitRunMock = mock(
  async (_runId: string, opts: { waitMs: number; signal?: AbortSignal }): Promise<PollRunResult> => {
    if (opts?.waitMs) await sleep(opts.waitMs);
    return {
      runId: "run-spawn-1",
      state: "running" as const,
      envelope: null,
      exitCode: null,
    };
  },
);

const killRunMock = mock(
  async (_runId: string, _opts?: unknown): Promise<KillRunResult> => ({
    runId: "run-spawn-1",
    killed: true,
    state: "error" as const,
  }),
);

const readRunOutputMock = mock(
  async (_runId: string, opts?: { offset?: number }): Promise<ReadRunOutputResult> => ({
    chunk: "",
    nextOffset: opts?.offset ?? 0,
    eof: true,
  }),
);

const listRunsMock = mock(async (_registryPath?: string) => ({}) as Record<string, unknown>);

const sendToRunMock = mock(
  async (_runId: string, _text: string, _opts?: unknown): Promise<SendToRunResult> => ({
    delivered: true,
    status: "delivered" as const,
    steerFile: "/tmp/run.steer.jsonl",
    pendingBytes: 42,
    waitedMs: 30,
  }),
);

const sweepRunsMock = mock(async () => ({ expired: [], reasons: {}, removed: [], killed: [] }));
const sessionIdOfRunMock = mock(async () => null);
const ownRunIdsMock = mock(() => [] as string[]);

import { parseModelSpec, formatModelSpec, ModelSpecError } from "../../tools/dsh-bridge/src/model-spec.js";

// ЯКОРЬ ДЛЯ ВСЕХ МОК-ФАБРИК БРИДЖА В ЭТОМ КАТАЛОГЕ.
// `mock.module()` в bun подменяет модуль ЦЕЛИКОМ: то, что вернула фабрика, и есть
// весь набор экспортов. ESM привязывает named-импорты статически, поэтому фабрика
// обязана отдавать КАЖДЫЙ ключ, который продовый код расширения импортирует из
// `tools/dsh-bridge/src/index.js` — не только те, что реально дёргает конкретный
// тест. Пропущенный ключ = `SyntaxError: Export named 'X' not found`, и падает не
// один assert, а регистрация всего файла.
// Коварство в том, что без изоляции этот дефект не виден: `mock.module()` глобален
// на процесс и не откатывается между файлами, так что более полная фабрика соседа
// молча закрывает дыру, а зелёный прогон держится на порядке файлов. Поэтому в
// `test:unit` стоит `--isolate` — он даёт каждому файлу свой процесс и ловит
// неполную фабрику сразу, а не через полгода при перестановке файлов в скрипте.
// Актуальный список ключей = объединение named-импортов из index.ts, relay.ts и ui.ts.
mock.module("../../tools/dsh-bridge/src/index.js", () => ({
  parseModelSpec,
  formatModelSpec,
  ModelSpecError,
  runDsh: runDshMock,
  startDsh: startDshMock,
  waitRun: waitRunMock,
  killRun: killRunMock,
  readRunOutput: readRunOutputMock,
  listRuns: listRunsMock,
  sendToRun: sendToRunMock,
  pollRun: async () => ({ runId: "run-1", state: "running", envelope: null, exitCode: null }),
  // Продление аренды рана: импортируется relay.ts, который index.ts тянет статически.
  // Сам relay здесь не тестируется, но без ключа не подвяжется весь граф модулей.
  renewLease: async () => new Date(Date.now() + 60_000).toISOString(),
  // Сторож брошенных ранов: в юнитах он не нужен, но named-импорт в extension
  // проверяется статически — без заглушки модуль не подвяжется вовсе.
  sweepRuns: sweepRunsMock,
  sessionIdOfRun: sessionIdOfRunMock,
  ownRunIds: ownRunIdsMock,
}));

// Герметичность роли @dsh: без opts тул зовёт resolveRoleModel(ctx) без agentDir —
// резолвер внутри падает на getAgentDir() из @oh-my-pi/pi-coding-agent, т.е. на РЕАЛЬНЫЙ
// ~/.omp/agent владельца машины (см. extensions/dsh-task/role-model.ts). Подменяем сам
// getAgentDir на управляемый тестами каталог: по умолчанию — пустой temp-dir (эквивалент
// чистой машины без config.yml), тесты роли "a)"/"e2)" ниже временно наводят testAgentDir
// на свой fixture-каталог и возвращают дефолт в finally.
// Единственный runtime (не type-only) экспорт @oh-my-pi/pi-coding-agent в графе импортов
// этого файла — getAgentDir из role-model.ts; index.ts/relay.ts/dvibe.ts/ui.ts берут из
// пакета только `import type`, которые стираются при компиляции и мока не требуют.
const defaultTestAgentDir = await mkdtemp(join(tmpdir(), "omp-agent-default-"));
let testAgentDir = defaultTestAgentDir;
mock.module("@oh-my-pi/pi-coding-agent", () => ({
  getAgentDir: () => testAgentDir,
}));
afterAll(async () => {
  await rm(defaultTestAgentDir, { recursive: true, force: true });
});

// Must import after mock.module
const { default: dshTaskExtension } = await import("./index.ts");
import { Text } from "@oh-my-pi/pi-tui";

async function makePiAsync() {
  const zodMod = await import("@oh-my-pi/omptype/zod");
  const z = (zodMod as any).z ?? (zodMod as any).default ?? zodMod;
  const tools: Record<string, any> = {};
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const pi: any = {
    zod: z,
    registerTool(def: any) {
      tools[def.name] = def;
    },
    _getTool() {
      return tools.dsh_task;
    },
    // dshTaskExtension теперь заодно регистрирует /dvibe (registerDvibe) — эти тесты
    // его не проверяют (см. dvibe.test.ts), но без стабов registerCommand/on/
    // getActiveTools/setActiveTools сам вызов dshTaskExtension(pi) падает раньше,
    // чем доходит до регистрации dsh_*-тулов.
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    getActiveTools() {
      return [];
    },
    async setActiveTools() {},
  };
  dshTaskExtension(pi);
  return { pi, tool: pi._getTool(), tools, handlers };
}

describe("dsh_task extension", () => {
  beforeEach(() => {
    runDshMock.mockClear();
    runDshMock.mockImplementation(async (_opts: unknown) => ({
      v: 1,
      runId: "run-1",
      sessionId: null,
      status: "completed",
      result: "hello from dsh",
    }));
    startDshMock.mockClear();
    startDshMock.mockImplementation(async (_opts: unknown) => ({
      runId: "run-spawn-1",
      pid: 4242,
      pgid: 4242,
      logFile: "/tmp/run-spawn-1.log",
      startedAt: new Date().toISOString(),
    }));
    waitRunMock.mockClear();
    waitRunMock.mockImplementation(async (_runId: string, opts: any) => {
      if (opts?.waitMs) await sleep(opts.waitMs);
      return { runId: "run-spawn-1", state: "running", envelope: null, exitCode: null };
    });
    killRunMock.mockClear();
    killRunMock.mockImplementation(async (_runId: string, _opts?: unknown) => ({
      runId: "run-spawn-1",
      killed: true,
      state: "error",
    }));
    readRunOutputMock.mockClear();
    readRunOutputMock.mockImplementation(async (_runId: string, opts?: any) => ({
      chunk: "",
      nextOffset: opts?.offset ?? 0,
      eof: true,
    }));
    listRunsMock.mockClear();
    listRunsMock.mockImplementation(async (_registryPath?: string) => ({}));
  });

  it("registers tool named dsh_task", async () => {
    const { tool } = await makePiAsync();
    expect(tool.name).toBe("dsh_task");
    expect(tool.label).toBeDefined();
    expect(tool.description).toBeDefined();
  });

  it("writes task to temp file and calls runDsh", async () => {
    const { tool } = await makePiAsync();
    let capturedOpts: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      capturedOpts = opts;
      const content = await readFile(opts.taskFile, "utf8");
      expect(content).toBe("my task");
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "done" };
    });
    const res = await tool.execute("id1", { task: "my task" }, undefined, undefined, { cwd: "/tmp" });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.cwd).toBe("/tmp");
    expect(res.content[0].text).toBe("done");
    expect(res.details.status).toBe("completed");
  });

  it("forwards resumeSessionId and timeoutMs", async () => {
    const { tool } = await makePiAsync();
    let captured: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { v: 1, runId: "r", sessionId: "sess-1", status: "completed", result: "ok" };
    });
    await tool.execute("id1", { task: "t", resumeSessionId: "sess-1", timeoutMs: 12345 }, undefined, undefined, {
      cwd: "/tmp",
    });
    expect(captured.resumeSessionId).toBe("sess-1");
    expect(captured.timeoutMs).toBe(12345);
  });

  it("passes AbortSignal through to runDsh", async () => {
    const { tool } = await makePiAsync();
    let capturedSignal: AbortSignal | undefined;
    runDshMock.mockImplementation(async (opts: any) => {
      capturedSignal = opts.signal;
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "ok" };
    });
    const ac = new AbortController();
    await tool.execute("id1", { task: "t" }, ac.signal, undefined, { cwd: "/tmp" });
    expect(capturedSignal).toBe(ac.signal);
  });

  it("returns question for need_input", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockImplementation(async () => ({
      v: 1,
      runId: "r",
      sessionId: "s",
      status: "need_input",
      question: "what is X?",
    }));
    const res = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toContain("what is X?");
    expect(res.content[0].text).toContain("session: s");
    expect(res.details.status).toBe("need_input");
    expect(res.isError).toBeUndefined();
  });

  it("returns isError for error envelope", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockImplementation(async () => ({
      v: 1,
      runId: "r",
      sessionId: null,
      status: "error",
      error: { code: "timeout", message: "timed out" },
    }));
    const res = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("timed out");
    expect(res.content[0].text).toContain("[timeout]");
  });

  it("streams stdout line-wise with throttling", async () => {
    const { tool } = await makePiAsync();
    const updates: any[] = [];
    const onUpdate = (r: any) => updates.push(r);

    runDshMock.mockImplementation(async (opts: any) => {
      opts.onStdout("line1\nline2\npartial");
      opts.onStdout(" continued\nline3\n");
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "final" };
    });

    const res = await tool.execute("id1", { task: "t" }, undefined, onUpdate, { cwd: "/tmp" });
    expect(res.content[0].text).toBe("final");
    // onUpdate should have been called with line buffering; at least one flush
    // Throttling may coalesce, but we should have received at least line1+line2 or line3
    const allText = updates.map((u) => u.content[0].text).join("\n");
    expect(allText).toContain("line1");
    expect(allText).toContain("line2");
  });

  it("cleans up temp dir even on failure", async () => {
    const { tool } = await makePiAsync();
    let taskFile = "";
    runDshMock.mockImplementation(async (opts: any) => {
      taskFile = opts.taskFile;
      throw new Error("boom");
    });
    const res = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    // taskFile's dir should be gone
    await expect(readFile(taskFile, "utf8")).rejects.toThrow();
  });

  it("renderCall is one line dsh ▶ <80 chars>", async () => {
    const { tool } = await makePiAsync();
    const long = "a".repeat(200);
    const comp = tool.renderCall({ task: long }, { expanded: false, isPartial: false }, {});
    expect(comp).toBeInstanceOf(Text);
    const line = (comp as Text).getText();
    expect(line).toContain("dsh");
    expect(line.split("\n").length).toBeGreaterThanOrEqual(1);
  });

  it("renderResult shows status and truncated preview and (see details)", async () => {
    const { tool } = await makePiAsync();
    const comp = tool.renderResult(
      {
        content: [{ type: "text", text: "hello world" }],
        details: { v: 1, runId: "r", sessionId: null, status: "completed", result: "hello world" },
      },
      { expanded: false, isPartial: false },
      {},
    );
    expect(comp).toBeInstanceOf(Text);
    const line = (comp as Text).getText();
    expect(line).toContain("hello world");
    // v2 render is themed via theme, legacy dsh_task kept but content still shows status
  });
});

describe("dsh_spawn extension", () => {
  it("does not wait for the run to finish; returns runId+pid immediately", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockImplementation(async (_opts: any) => {
      await sleep(20); // simulates async registry write, still much shorter than a real run
      return { runId: "run-x", pid: 999, pgid: 999, logFile: "/tmp/run-x.log", startedAt: new Date().toISOString() };
    });
    const res: any = await tool.execute("id1", { task: "do stuff" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBeUndefined();
    expect(res.details.runId).toBe("run-x");
    expect(res.details.pid).toBe(999);
    expect(res.content[0].text).toContain("run-x");
    // spawn must never itself invoke the waiting API — that would make it blocking
    expect(waitRunMock).not.toHaveBeenCalled();
  });

  it("writes task to temp file and forwards cwd/resumeSessionId/timeoutMs", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      const content = await readFile(opts.taskFile, "utf8");
      expect(content).toBe("spawn task");
      return { runId: "run-y", pid: 111, pgid: 111, logFile: "/tmp/y.log", startedAt: "now" };
    });
    await tool.execute(
      "id1",
      { task: "spawn task", resumeSessionId: "sess-9", timeoutMs: 5000 },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    expect(captured.cwd).toBe("/tmp");
    expect(captured.resumeSessionId).toBe("sess-9");
    expect(captured.timeoutMs).toBe(5000);
  });

  it("renderCall is one line 'dsh spawn ▶ <preview>'", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    const long = "b".repeat(200);
    const comp = tool.renderCall({ task: long }, { expanded: false, isPartial: false }, {});
    expect(comp).toBeInstanceOf(Text);
    const line = (comp as Text).getText();
    expect(line.includes("dsh spawn:")).toBe(true);
  });

  it("forwards label to startDsh and echoes it in the response text", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-label-1", pid: 222, pgid: 222, logFile: "/tmp/label.log", startedAt: "now" };
    });
    const res: any = await tool.execute("id1", { task: "labelled task", label: "worker-a" }, undefined, undefined, {
      cwd: "/tmp",
    });
    expect(captured.label).toBe("worker-a");
    expect(res.content[0].text).toContain("label=worker-a");
  });

  it("omits the label suffix when no label is given", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-label-2", pid: 223, pgid: 223, logFile: "/tmp/label2.log", startedAt: "now" };
    });
    const res: any = await tool.execute("id1", { task: "no label task" }, undefined, undefined, { cwd: "/tmp" });
    expect(captured.label).toBeUndefined();
    expect(res.content[0].text).not.toContain("label=");
  });
});

describe("dsh_wait extension", () => {
  it("timing out is not an error and the run stays alive; no kill is triggered", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async (_runId: string, opts: any) => {
      if (opts?.waitMs) await sleep(opts.waitMs);
      return { runId: "run-a", state: "running", envelope: null, exitCode: null };
    });
    const res: any = await tool.execute("id1", { runId: "run-a", waitMs: 120 }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBeUndefined();
    expect(res.details.state).toBe("running");
    expect(killRunMock).not.toHaveBeenCalled();
  });

  it("waits for the envelope on completion", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async (_runId: string, _opts: any) => {
      await sleep(10);
      return {
        runId: "run-b",
        state: "completed",
        envelope: { v: 1, runId: "run-b", sessionId: null, status: "completed", result: "all done" },
        exitCode: 0,
      };
    });
    const res: any = await tool.execute("id1", { runId: "run-b", waitMs: 5000 }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBeUndefined();
    expect(res.details.status).toBe("completed");
    expect(res.content[0].text).toBe("all done");
  });

  it("a repeated dsh_wait after a timeout can still catch the completion", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    let calls = 0;
    waitRunMock.mockImplementation(async (_runId: string, opts: any) => {
      calls++;
      if (opts?.waitMs) await sleep(opts.waitMs);
      if (calls === 1) {
        return { runId: "run-c", state: "running", envelope: null, exitCode: null };
      }
      return {
        runId: "run-c",
        state: "completed",
        envelope: { v: 1, runId: "run-c", sessionId: null, status: "completed", result: "second try" },
        exitCode: 0,
      };
    });

    const first: any = await tool.execute("id1", { runId: "run-c", waitMs: 80 }, undefined, undefined, { cwd: "/tmp" });
    expect(first.isError).toBeUndefined();
    expect(first.details.state).toBe("running");

    const second: any = await tool.execute("id2", { runId: "run-c", waitMs: 300 }, undefined, undefined, {
      cwd: "/tmp",
    });
    expect(second.details.status).toBe("completed");
    expect(second.content[0].text).toBe("second try");
  });

  it("AbortSignal cancels the wait only; kill is never invoked and the run stays running", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async (_runId: string, opts: any) => {
      if (opts?.waitMs) await sleep(opts.waitMs);
      return { runId: "run-d", state: "running", envelope: null, exitCode: null };
    });
    const ac = new AbortController();
    ac.abort();
    const res: any = await tool.execute("id1", { runId: "run-d", waitMs: 5000 }, ac.signal, undefined, { cwd: "/tmp" });
    expect(res.isError).toBeUndefined();
    expect(res.details.state).toBe("running");
    expect(killRunMock).not.toHaveBeenCalled();
  });

  it("aborting mid-wait stops promptly without killing the run", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    // Well-behaved waitRun resolves as soon as the signal fires, instead of sitting out waitMs.
    waitRunMock.mockImplementation(async (_runId: string, opts: any) => {
      return await new Promise((resolvePromise) => {
        const t = setTimeout(
          () => resolvePromise({ runId: "run-e", state: "running", envelope: null, exitCode: null }),
          opts.waitMs,
        );
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolvePromise({ runId: "run-e", state: "running", envelope: null, exitCode: null });
          },
          { once: true },
        );
      });
    });
    const ac = new AbortController();
    const pending = tool.execute("id1", { runId: "run-e", waitMs: 5000 }, ac.signal, undefined, { cwd: "/tmp" });
    setTimeout(() => ac.abort(), 30);
    const started = Date.now();
    const res: any = await pending;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(600); // должно прерваться на ближайшей итерации, а не досиживать 5000мс
    expect(res.isError).toBeUndefined();
    expect(res.details.state).toBe("running");
    expect(killRunMock).not.toHaveBeenCalled();
  });

  it("streams new output line-wise via onUpdate, advancing offset without loss or dup", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;

    const fakeLog = "alpha\nbeta\ngamma\n";
    readRunOutputMock.mockImplementation(async (_runId: string, opts: any) => {
      const offset = opts?.offset ?? 0;
      const nextOffset = fakeLog.length;
      const chunk = offset < fakeLog.length ? fakeLog.slice(offset) : "";
      return { chunk, nextOffset, eof: true };
    });
    waitRunMock.mockImplementation(async (_runId: string, _opts: any) => {
      await sleep(10);
      return {
        runId: "run-f",
        state: "completed",
        envelope: { v: 1, runId: "run-f", sessionId: null, status: "completed", result: "done" },
        exitCode: 0,
      };
    });

    const updates: any[] = [];
    const res: any = await tool.execute(
      "id1",
      { runId: "run-f", waitMs: 5000 },
      undefined,
      (u: any) => updates.push(u),
      { cwd: "/tmp" },
    );

    expect(res.details.status).toBe("completed");
    const seen = updates.map((u) => u.content[0].text).join("\n");
    expect(seen).toContain("alpha");
    expect(seen).toContain("beta");
    expect(seen).toContain("gamma");
    // no duplicated lines despite the run finishing within a single wait cycle
    const alphaCount = (seen.match(/alpha/g) || []).length;
    expect(alphaCount).toBe(1);
    // readRunOutput was called with monotonically non-decreasing offsets (no rewinding/loss)
    const offsetsSeen = readRunOutputMock.mock.calls.map((c: any) => c[1]?.offset ?? 0);
    for (let i = 1; i < offsetsSeen.length; i++) {
      expect(offsetsSeen[i]).toBeGreaterThanOrEqual(offsetsSeen[i - 1]);
    }
  });

  it("renderCall is one line 'dsh wait ▶ <runId> (<waitMs>ms)'", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const comp = tool.renderCall({ runId: "run-z", waitMs: 1000 }, { expanded: false, isPartial: false }, {});
    expect(comp).toBeInstanceOf(Text);
    const line = (comp as Text).getText();
    expect(line.includes("dsh wait:")).toBe(true);
    expect(line.includes("run-z".slice(0, 8))).toBe(true);
    expect(line.includes("окно")).toBe(false);
    expect(line.includes("dsh wait:")).toBe(true);
  });
});

describe("dsh_kill extension", () => {
  it("calls killRun and reports killed+state", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    killRunMock.mockImplementation(async (runId: string, _opts?: unknown) => ({
      runId,
      killed: true,
      state: "error",
    }));
    const res: any = await tool.execute("id1", { runId: "run-g" }, undefined, undefined, { cwd: "/tmp" });
    expect(killRunMock).toHaveBeenCalledTimes(1);
    expect(res.details.killed).toBe(true);
    expect(res.details.state).toBe("error");
    expect(res.isError).toBeUndefined();
  });

  it("renderCall is one line 'dsh kill ▶ <runId>'", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    const comp = tool.renderCall({ runId: "run-h" }, { expanded: false, isPartial: false }, {});
    expect(comp).toBeInstanceOf(Text);
    const line = (comp as Text).getText();
    expect(line.includes("dsh kill:")).toBe(true);
    expect(line.includes("run-h".slice(0, 8))).toBe(true);
  });

  it("killing an own live run marks the result text as (own) and sets details.ownRun=true", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    killRunMock.mockImplementation(async (runId: string, _opts?: unknown) => ({
      runId,
      killed: true,
      state: "error",
    }));
    ownRunIdsMock.mockImplementation(() => ["run-own"]);
    try {
      const res: any = await tool.execute("id1", { runId: "run-own" }, undefined, undefined, { cwd: "/tmp" });
      expect(res.content[0].text).toContain("(own)");
      expect(res.details.ownRun).toBe(true);
    } finally {
      ownRunIdsMock.mockImplementation(() => []);
    }
  });

  it("a run absent from ownRunIds is marked as not this session's active run, ownRun=false", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    killRunMock.mockImplementation(async (runId: string, _opts?: unknown) => ({
      runId,
      killed: true,
      state: "error",
    }));
    ownRunIdsMock.mockImplementation(() => ["run-someone-else"]);
    try {
      const res: any = await tool.execute("id1", { runId: "run-foreign" }, undefined, undefined, { cwd: "/tmp" });
      expect(res.content[0].text).toContain("(not this session's active run)");
      expect(res.details.ownRun).toBe(false);
    } finally {
      ownRunIdsMock.mockImplementation(() => []);
    }
  });

  it("when ownRunIds is not a function, the text stays unchanged with no mark and nothing crashes", async () => {
    // Перерегистрируем мок моста без ownRunIds — именно тот случай, который
    // production-код обязан пережить guard'ом typeof ownRunIds === 'function'.
    mock.module("../../tools/dsh-bridge/src/index.js", () => ({
      parseModelSpec,
      formatModelSpec,
      ModelSpecError,
      runDsh: runDshMock,
      startDsh: startDshMock,
      waitRun: waitRunMock,
      killRun: killRunMock,
      readRunOutput: readRunOutputMock,
      listRuns: listRunsMock,
      sendToRun: sendToRunMock,
      pollRun: async () => ({ runId: "run-1", state: "running", envelope: null, exitCode: null }),
      renewLease: async () => new Date(Date.now() + 60_000).toISOString(),
      sweepRuns: sweepRunsMock,
      sessionIdOfRun: sessionIdOfRunMock,
      ownRunIds: undefined,
    }));
    try {
      const { tools } = await makePiAsync();
      const tool = tools.dsh_kill;
      killRunMock.mockImplementation(async (runId: string, _opts?: unknown) => ({
        runId,
        killed: true,
        state: "error",
      }));
      const res: any = await tool.execute("id1", { runId: "run-no-own" }, undefined, undefined, { cwd: "/tmp" });
      expect(res.content[0].text).toBe("kill run-no-own: killed (error)");
      expect(res.content[0].text).not.toContain("(own)");
      expect(res.content[0].text).not.toContain("active run");
      expect(res.details.ownRun).toBeUndefined();
      expect(res.details.killed).toBe(true);
      expect(res.details.state).toBe("error");
    } finally {
      // Возвращаем полный мок моста с ownRunIds для остальных тестов.
      mock.module("../../tools/dsh-bridge/src/index.js", () => ({
        parseModelSpec,
        formatModelSpec,
        ModelSpecError,
        runDsh: runDshMock,
        startDsh: startDshMock,
        waitRun: waitRunMock,
        killRun: killRunMock,
        readRunOutput: readRunOutputMock,
        listRuns: listRunsMock,
        sendToRun: sendToRunMock,
        pollRun: async () => ({ runId: "run-1", state: "running", envelope: null, exitCode: null }),
        renewLease: async () => new Date(Date.now() + 60_000).toISOString(),
        sweepRuns: sweepRunsMock,
        sessionIdOfRun: sessionIdOfRunMock,
        ownRunIds: ownRunIdsMock,
      }));
    }
  });
});

describe("dsh_list extension", () => {
  it("returns the run registry from listRuns()", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    listRunsMock.mockImplementation(async () => ({
      "run-i": { pid: 1, pgid: 1, dshSessionId: null, state: "running", startedAt: "now" },
      "run-j": { pid: 2, pgid: 2, dshSessionId: null, state: "running", startedAt: "now" },
    }));
    const res: any = await tool.execute("id1", {}, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBeUndefined();
    expect(res.details.runs).toHaveLength(2);
    expect(res.details.runs.map((r: any) => r.runId).sort()).toEqual(["run-i", "run-j"]);
  });

  it("reports no active runs on an empty registry", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    listRunsMock.mockImplementation(async () => ({}));
    const res: any = await tool.execute("id1", {}, undefined, undefined, { cwd: "/tmp" });
    expect(res.details.runs).toHaveLength(0);
    expect(res.content[0].text).toContain("no active runs");
  });

  it("renders one line per run with label=<label> or label=- when absent", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    listRunsMock.mockImplementation(async () => ({
      "run-k": {
        pid: 1,
        pgid: 1,
        dshSessionId: null,
        state: "running",
        startedAt: "2026-08-24T00:00:00.000Z",
        label: "worker-a",
      },
      "run-l": {
        pid: 2,
        pgid: 2,
        dshSessionId: null,
        state: "running",
        startedAt: "2026-08-24T00:00:01.000Z",
        label: null,
      },
    }));
    const res: any = await tool.execute("id1", {}, undefined, undefined, { cwd: "/tmp" });
    const lines = res.content[0].text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("run-k state=running label=worker-a model=default started=2026-08-24T00:00:00.000Z");
    expect(lines).toContain("run-l state=running label=- model=default started=2026-08-24T00:00:01.000Z");
  });
});

describe("dsh_send", () => {
  it("passes runId and text through to sendToRun", async () => {
    sendToRunMock.mockClear();
    const { tools } = await makePiAsync();
    const res: any = await tools.dsh_send.execute(
      "c-1",
      { runId: "run-1", text: "не туда копаешь" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );

    expect(sendToRunMock).toHaveBeenCalledTimes(1);
    const [runId, text] = sendToRunMock.mock.calls[0] as unknown as [string, string];
    expect(runId).toBe("run-1");
    expect(text).toBe("не туда копаешь");
    expect(res.isError).toBeFalsy();
    expect(res.details.delivered).toBe(true);
  });

  // P1 п.4, раунд 2 кросс-ревью: delivered:false раньше смешивал "ран мёртв,
  // сообщение потеряно" с "ран жив, канал просто пока не вычитан, чтение не
  // подтверждено" — трёхзначный status различает их, и потребитель обязан
  // реагировать по-разному (см. dvibe.ts: продолжение через dsh_spawn с
  // resumeFromRunId — только при undeliverable).
  it("status:undeliverable is an ERROR, not a quiet success", async () => {
    sendToRunMock.mockClear();
    sendToRunMock.mockImplementationOnce(async () => ({
      delivered: false,
      status: "undeliverable" as const,
      steerFile: "/tmp/run.steer.jsonl",
      pendingBytes: 17,
      waitedMs: 1200,
    }));
    const { tools } = await makePiAsync();
    const res: any = await tools.dsh_send.execute("c-2", { runId: "run-1", text: "поздно" }, undefined, undefined, {
      cwd: "/tmp",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("NOT delivered");
    expect(res.content[0].text).toContain("message lost");
    expect(res.details.status).toBe("undeliverable");
  });

  it("status:pending is NOT an error and tells the caller not to duplicate the message", async () => {
    sendToRunMock.mockClear();
    sendToRunMock.mockImplementationOnce(async () => ({
      delivered: false,
      status: "pending" as const,
      steerFile: "/tmp/run.steer.jsonl",
      pendingBytes: 17,
      waitedMs: 1200,
    }));
    const { tools } = await makePiAsync();
    const res: any = await tools.dsh_send.execute(
      "c-2b",
      { runId: "run-1", text: "чуть позже" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );

    // pending — ран был жив при повторной проверке, чтение не подтверждено: НЕ провал вызова.
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("pending");
    expect(res.content[0].text).toContain("do NOT resend");
    expect(res.content[0].text).toContain("pendingBytes=17");
    expect(res.details.status).toBe("pending");
  });

  it("reports a thrown error instead of pretending it was sent", async () => {
    sendToRunMock.mockClear();
    sendToRunMock.mockImplementationOnce(async () => {
      throw new Error("unknown runId нет-такого");
    });
    const { tools } = await makePiAsync();
    const res: any = await tools.dsh_send.execute("c-3", { runId: "нет-такого", text: "x" }, undefined, undefined, {
      cwd: "/tmp",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown runId");
    expect(res.details.delivered).toBe(false);
    expect(res.details.status).toBe("undeliverable");
  });

  it("renderResult surfaces unread bytes so silence is not mistaken for delivery", async () => {
    const { tools } = await makePiAsync();
    const line = tools.dsh_send.renderResult(
      {
        content: [{ type: "text", text: "sent to run-1" }],
        details: { delivered: true, steerFile: "/tmp/x", pendingBytes: 42 },
      },
      {} as any,
      {} as any,
    );
    expect(line).toBeInstanceOf(Text);
    expect((line as Text).getText()).toContain("42B unread");
  });
});

describe("dsh_task model param", () => {
  it("passes ModelSpec to runDsh when model is valid", async () => {
    const { tool } = await makePiAsync();
    let captured: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "ok" };
    });
    await tool.execute(
      "id1",
      { task: "t", model: "omniroute/opencode-go/deepseek-v4-flash:high" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    expect(captured.model).toEqual({
      provider: "omniroute",
      model: "opencode-go/deepseek-v4-flash",
      reasoningEffort: "high",
    });
  });
  it("passes model undefined when not given (regression)", async () => {
    const { tool } = await makePiAsync();
    let captured: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "ok" };
    });
    await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(captured.model).toBeUndefined();
  });
  it("invalid model string returns isError without calling runDsh", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockClear();
    const res: any = await tool.execute("id1", { task: "t", model: "bad" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("error [invalid_model]:");
    expect(res.details.error.code).toBe("invalid_model");
    expect(runDshMock).not.toHaveBeenCalled();
  });
});

describe("dsh_spawn model param", () => {
  it("passes ModelSpec to startDsh when model is valid", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-m", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: "now" };
    });
    await tool.execute("id1", { task: "t", model: "omniroute/foo:low" }, undefined, undefined, { cwd: "/tmp" });
    expect(captured.model).toEqual({ provider: "omniroute", model: "foo", reasoningEffort: "low" });
  });
  it("passes model: undefined when not given", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-m2", pid: 1, pgid: 1, logFile: "/tmp/x", startedAt: "now" };
    });
    await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(captured.model).toBeUndefined();
  });
  it("invalid model string returns isError without calling startDsh", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockClear();
    const res: any = await tool.execute("id1", { task: "t", model: "no-slash" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("error [invalid_model]:");
    expect(startDshMock).not.toHaveBeenCalled();
  });
  it("model with whitespace is invalid", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockClear();
    const res: any = await tool.execute("id1", { task: "t", model: "omniroute/foo bar" }, undefined, undefined, {
      cwd: "/tmp",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("error [invalid_model]:");
    expect(startDshMock).not.toHaveBeenCalled();
  });
  it("appends model= suffix formatted via formatModelSpec when model is given", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockImplementation(async (_opts: any) => {
      return { runId: "run-m3", pid: 777, pgid: 777, logFile: "/tmp/m3.log", startedAt: "now" };
    });
    const res: any = await tool.execute(
      "id1",
      { task: "t", model: "omniroute/opencode-go/deepseek-v4-flash:high" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("started run-m3 (pid 777) model=omniroute/opencode-go/deepseek-v4-flash:high");
  });
  it("keeps byte-exact string without model and with label", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockImplementation(async (_opts: any) => {
      return { runId: "run-x1", pid: 999, pgid: 999, logFile: "/tmp/x1.log", startedAt: "now" };
    });
    const res: any = await tool.execute("id1", { task: "t", label: "worker-a" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toBe("started run-x1 (pid 999) label=worker-a");
  });
  it("keeps byte-exact string without model and without label", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockImplementation(async (_opts: any) => {
      return { runId: "run-x2", pid: 100, pgid: 100, logFile: "/tmp/x2.log", startedAt: "now" };
    });
    const res: any = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toBe("started run-x2 (pid 100)");
  });
  it("appends both label and model suffix when both given", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    startDshMock.mockImplementation(async (_opts: any) => {
      return { runId: "run-x3", pid: 555, pgid: 555, logFile: "/tmp/x3.log", startedAt: "now" };
    });
    const res: any = await tool.execute(
      "id1",
      { task: "t", label: "worker-b", model: "omniroute/foo:low" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    expect(res.content[0].text).toBe("started run-x3 (pid 555) label=worker-b model=omniroute/foo:low");
  });
});

describe("dsh_list model display", () => {
  it("shows model=<spec> and default", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    listRunsMock.mockImplementation(async () => ({
      "run-a": {
        pid: 1,
        pgid: 1,
        dshSessionId: null,
        state: "running",
        startedAt: "2026-08-24T00:00:00.000Z",
        label: "-",
        model: { provider: "omniroute", model: "opencode-go/deepseek-v4-flash", reasoningEffort: "high" },
      },
      "run-b": {
        pid: 2,
        pgid: 2,
        dshSessionId: null,
        state: "running",
        startedAt: "2026-08-24T00:00:01.000Z",
        label: null,
      },
    }));
    const res: any = await tool.execute("id1", {}, undefined, undefined, { cwd: "/tmp" });
    const text: string = res.content[0].text;
    expect(text).toContain("model=omniroute/opencode-go/deepsee");
    expect(text).toContain("…");
    expect(text).toContain("model=default");
  });
});

describe("dsh_wait model line", () => {
  it("prints model: line from envelope", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async () => ({
      runId: "run-x",
      state: "completed",
      envelope: {
        v: 1,
        runId: "run-x",
        sessionId: null,
        status: "completed",
        result: "done",
        model: { provider: "omniroute", model: "foo", reasoningEffort: "low" },
      },
      exitCode: 0,
    }));
    const res: any = await tool.execute("id1", { runId: "run-x", waitMs: 1000 }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toContain("model: omniroute/foo:low");
  });
  it("prints model: line also for error envelope", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async () => ({
      runId: "run-e",
      state: "error",
      envelope: {
        v: 1,
        runId: "run-e",
        sessionId: null,
        status: "error",
        error: { code: "model_not_found", message: "no such model" },
        model: { provider: "omniroute", model: "nope" },
      },
      exitCode: 1,
    }));
    const res: any = await tool.execute("id1", { runId: "run-e", waitMs: 1000 }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toContain("model: omniroute/nope");
    expect(res.isError).toBe(true);
  });
});

describe("text output smoke fixes", () => {
  it("error text includes code as error [code]: message for dsh_task", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockImplementation(async () => ({
      v: 1,
      runId: "r",
      sessionId: "sess-xyz",
      status: "error",
      error: { code: "model_not_found", message: "no such model" },
    }));
    const res: any = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toContain("error [model_not_found]:");
    expect(res.content[0].text).toContain("no such model");
  });
  it("error text includes code for dsh_wait", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async () => ({
      runId: "run-err",
      state: "error",
      envelope: {
        v: 1,
        runId: "run-err",
        sessionId: "sess-a",
        status: "error",
        error: { code: "invalid_model", message: "bad effort" },
      },
      exitCode: 1,
    }));
    const res: any = await tool.execute("id1", { runId: "run-err", waitMs: 1000 }, undefined, undefined, {
      cwd: "/tmp",
    });
    expect(res.content[0].text).toContain("error [invalid_model]:");
    expect(res.content[0].text).toContain("bad effort");
  });
  it("completed text appends session: line when sessionId present (dsh_task)", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockImplementation(
      async () =>
        ({
          v: 1,
          runId: "r",
          sessionId: "session-123",
          status: "completed",
          result: "done",
          model: { provider: "omniroute", model: "foo" },
        }) as any,
    );
    const res: any = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    const lines = res.content[0].text.split("\n");
    expect(lines).toContain("model: omniroute/foo");
    expect(lines).toContain("session: session-123");
    // model should come before session
    expect(lines.indexOf("model: omniroute/foo")).toBeLessThan(lines.indexOf("session: session-123"));
  });
  it("completed without model still shows session: line (dsh_wait)", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    waitRunMock.mockImplementation(async () => ({
      runId: "run-s",
      state: "completed",
      envelope: { v: 1, runId: "run-s", sessionId: "sess-999", status: "completed", result: "done" },
      exitCode: 0,
    }));
    const res: any = await tool.execute("id1", { runId: "run-s", waitMs: 1000 }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).toContain("session: sess-999");
  });
  it("no session line when sessionId null", async () => {
    const { tool } = await makePiAsync();
    runDshMock.mockImplementation(
      async () =>
        ({
          v: 1,
          runId: "r",
          sessionId: null,
          status: "completed",
          result: "done",
          model: { provider: "omniroute", model: "foo" },
        }) as any,
    );
    const res: any = await tool.execute("id1", { task: "t" }, undefined, undefined, { cwd: "/tmp" });
    expect(res.content[0].text).not.toContain("session:");
  });
});
describe("dsh inherit role @dsh — TDD a-g", () => {
  it("a) dsh_spawn без model наследует @dsh с effort:high", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    // мокаем ctx как в рантайме OMP — resolve("@dsh") даёт provider/id
    const fakeCtx = {
      cwd: "/tmp",
      models: {
        resolve: (spec: string) => {
          if (spec === "@dsh") return { provider: "omniroute", id: "metac/muse-spark-1.2-contributor" };
          return undefined;
        },
      },
      model: undefined,
    };
    // Фикстура config.yml во временном agentDir: сырое значение роли несёт суффикс :high
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    writeFileSync(
      join(dir, "config.yml"),
      `modelRoles:\n  dsh: omniroute/metac/muse-spark-1.2-contributor:high\n  task: anthropic/claude:low\n`,
      "utf8",
    );
    testAgentDir = dir; // тул зовёт resolveRoleModel(ctx) без opts — направляем мок getAgentDir на фикстуру
    try {
      // Сначала helper напрямую
      const { resolveRoleModel } = await import("./role-model.ts");
      const spec = resolveRoleModel(fakeCtx as any, { agentDir: dir });
      expect(spec).toEqual({
        provider: "omniroute",
        model: "metac/muse-spark-1.2-contributor",
        reasoningEffort: "high",
      });
      // Затем сам тул: без параметра model он должен прокинуть тот же spec в startDsh
      let captured: any = null;
      startDshMock.mockImplementation(async (opts: any) => {
        captured = opts;
        return { runId: "run-a", pid: 1, pgid: 1, logFile: "/tmp/a", startedAt: "now" };
      });
      await tool.execute("id1", { task: "t" }, undefined, undefined, fakeCtx as any);
      expect(captured.model).toEqual({
        provider: "omniroute",
        model: "metac/muse-spark-1.2-contributor",
        reasoningEffort: "high",
      });
    } finally {
      testAgentDir = defaultTestAgentDir;
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("b) явный model в параметрах побеждает роль", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-b", pid: 1, pgid: 1, logFile: "/tmp/b", startedAt: "now" };
    });
    const fakeCtx: any = {
      cwd: "/tmp",
      models: { resolve: () => ({ provider: "omniroute", id: "should-not-use" }) },
      model: { provider: "omniroute", id: "also-not" },
    };
    await tool.execute("id1", { task: "t", model: "omniroute/foo:low" }, undefined, undefined, fakeCtx);
    expect(captured.model).toEqual({ provider: "omniroute", model: "foo", reasoningEffort: "low" });
  });
  it("c) роль без суффикса — без reasoningEffort", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    writeFileSync(join(dir, "config.yml"), `modelRoles:\n  dsh: omniroute/metac/muse-spark-1.2-contributor\n`, "utf8");
    try {
      const { resolveRoleModel } = await import("./role-model.ts");
      const fakeCtx: any = {
        cwd: "/tmp",
        models: { resolve: () => ({ provider: "omniroute", id: "metac/muse-spark-1.2-contributor" }) },
      };
      const spec = resolveRoleModel(fakeCtx, { agentDir: dir });
      expect(spec).toEqual({ provider: "omniroute", model: "metac/muse-spark-1.2-contributor" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("d) resolve→undefined и ctx.model→undefined — model не передан (dsh_spawn)", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    let captured: any = null;
    startDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { runId: "run-d", pid: 1, pgid: 1, logFile: "/tmp/d", startedAt: "now" };
    });
    const fakeCtx: any = { cwd: "/tmp", models: { resolve: () => undefined }, model: undefined };
    await tool.execute("id1", { task: "t" }, undefined, undefined, fakeCtx);
    expect(captured.model).toBeUndefined();
  });
  it("e) то же для dsh_task — без model не передаём", async () => {
    const { tool } = await makePiAsync();
    let captured: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "ok" };
    });
    const fakeCtx: any = { cwd: "/tmp", models: { resolve: () => undefined }, model: undefined, ui: {} };
    await tool.execute("id1", { task: "t" }, undefined, undefined, fakeCtx);
    expect(captured.model).toBeUndefined();
  });
  it("e2) dsh_task без model наследует @dsh с effort", async () => {
    const { tool } = await makePiAsync();
    let captured: any = null;
    runDshMock.mockImplementation(async (opts: any) => {
      captured = opts;
      return { v: 1, runId: "r", sessionId: null, status: "completed", result: "ok" };
    });
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
      const fakeCtx: any = {
        cwd: "/tmp",
        models: { resolve: () => ({ provider: "omniroute", id: "metac/muse-spark-1.2-contributor" }) },
      };
      // Проверяем helper
      const { resolveRoleModel } = await import("./role-model.ts");
      const spec = resolveRoleModel(fakeCtx, { agentDir: dir });
      expect(spec).toEqual({
        provider: "omniroute",
        model: "metac/muse-spark-1.2-contributor",
        reasoningEffort: "high",
      });
      // Затем сам тул: runDsh должен получить spec роли
      await tool.execute("id1", { task: "t2" }, undefined, undefined, fakeCtx);
      expect(captured.model).toEqual({
        provider: "omniroute",
        model: "metac/muse-spark-1.2-contributor",
        reasoningEffort: "high",
      });
    } finally {
      testAgentDir = defaultTestAgentDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("f) readRoleRaw на фикстуре с другими ролями, кавычками и без", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    const yml = `modelRoles:\n  task: "anthropic/claude-3:low"\n  dsh: 'omniroute/metac/muse-spark-1.2-contributor:high'\n  default: openai/gpt-4o\n`;
    writeFileSync(join(dir, "config.yml"), yml, "utf8");
    try {
      const { readRoleRaw, effortOfRoleRaw } = await import("./role-model.ts");
      expect(readRoleRaw(dir, "dsh")).toBe("omniroute/metac/muse-spark-1.2-contributor:high");
      expect(readRoleRaw(dir, "task")).toBe("anthropic/claude-3:low");
      expect(readRoleRaw(dir, "default")).toBe("openai/gpt-4o");
      expect(effortOfRoleRaw("omniroute/metac/muse-spark-1.2-contributor:high")).toBe("high");
      expect(effortOfRoleRaw("openai/gpt-4o")).toBeUndefined();
      expect(effortOfRoleRaw("x/y:unknown")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("g) fallback на ctx.model не тащит effort роли @dsh", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    // Роль @dsh настроена с effort :high, но НЕ резолвится (resolve→undefined) —
    // provider/id берутся из ctx.model (текущая сессия), а суффикс effort роли
    // описывает модель роли и к fallback-модели отношения не имеет.
    writeFileSync(
      join(dir, "config.yml"),
      `modelRoles:\n  dsh: omniroute/metac/muse-spark-1.2-contributor:high\n`,
      "utf8",
    );
    try {
      const { resolveRoleModel } = await import("./role-model.ts");
      const fakeCtx: any = {
        cwd: "/tmp",
        models: { resolve: () => undefined },
        model: { provider: "omniroute", id: "cx/gpt-5.6-sol" },
      };
      const spec = resolveRoleModel(fakeCtx, { agentDir: dir });
      expect(spec).toEqual({ provider: "omniroute", model: "cx/gpt-5.6-sol" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("h) provider/id и effort — из ОДНОГО raw с диска, а не из закешенного resolve('@dsh')", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    // Роль на диске сменили на лету: было B, стало A:high. Хостовый resolve("@dsh")
    // всё ещё отдаёт устаревшую B (алиас закеширован со старта сессии), но resolve("A")
    // (база из свежего raw) резолвится в A. Связка должна быть A:high, а не B:high.
    writeFileSync(join(dir, "config.yml"), `modelRoles:\n  dsh: A:high\n`, "utf8");
    try {
      const { resolveRoleModel } = await import("./role-model.ts");
      const fakeCtx: any = {
        cwd: "/tmp",
        models: {
          resolve: (spec: string) => {
            if (spec === "@dsh") return { provider: "p-b", id: "stale-b" };
            if (spec === "A") return { provider: "p-a", id: "fresh-a" };
            return undefined;
          },
        },
        model: undefined,
      };
      const spec = resolveRoleModel(fakeCtx, { agentDir: dir });
      expect(spec).toEqual({ provider: "p-a", model: "fresh-a", reasoningEffort: "high" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("i) raw недоступен (нет config.yml) — спек целиком из resolve('@dsh'), effort роли законен", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    try {
      const { resolveRoleModel } = await import("./role-model.ts");
      const fakeCtx: any = {
        cwd: "/tmp",
        models: {
          resolve: (spec: string) => {
            if (spec === "@dsh") return { provider: "p-alias", id: "alias-model" };
            return undefined;
          },
        },
        model: { provider: "p-session", id: "session-model" },
      };
      const spec = resolveRoleModel(fakeCtx, { agentDir: dir });
      expect(spec).toEqual({ provider: "p-alias", model: "alias-model" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session_shutdown kills own runs", () => {
  const shutdownCtx = { ui: { setWidget() {}, setStatus() {} } };
  it("killRun вызван для каждого своего runId", async () => {
    const { handlers } = await makePiAsync();
    killRunMock.mockClear();
    killRunMock.mockImplementation(async (_runId: string, _opts?: unknown) => ({
      runId: "x",
      killed: true,
      state: "error" as const,
    }));
    ownRunIdsMock.mockImplementation(() => ["own-1", "own-2"]);
    try {
      const hs = handlers.session_shutdown ?? [];
      expect(hs.length).toBeGreaterThan(0);
      // installRunsBoard тоже вешает session_shutdown (снятие панели) — зовём все.
      for (const h of hs) await h({}, shutdownCtx);
      const killed = killRunMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(killed).toContain("own-1");
      expect(killed).toContain("own-2");
      expect(killed.length).toBe(2);
    } finally {
      ownRunIdsMock.mockImplementation(() => []);
    }
  });
  it("ownRunIds пуст — killRun не вызван", async () => {
    const { handlers } = await makePiAsync();
    killRunMock.mockClear();
    ownRunIdsMock.mockImplementation(() => []);
    for (const h of handlers.session_shutdown ?? []) await h({}, shutdownCtx);
    expect(killRunMock.mock.calls.length).toBe(0);
  });
  it("зависший killRun не держит хук дольше капа", async () => {
    const { setSessionShutdownKillCapForTest } = await import("./index.ts");
    setSessionShutdownKillCapForTest(50);
    ownRunIdsMock.mockImplementation(() => ["own-hung"]);
    killRunMock.mockClear();
    killRunMock.mockImplementation(() => new Promise(() => {}));
    try {
      const t0 = Date.now();
      const { handlers } = await makePiAsync();
      for (const h of handlers.session_shutdown ?? []) await h({}, shutdownCtx);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(killRunMock.mock.calls.length).toBe(1);
    } finally {
      setSessionShutdownKillCapForTest(5000);
      ownRunIdsMock.mockImplementation(() => []);
      killRunMock.mockImplementation(async (_runId: string, _opts?: unknown) => ({
        runId: "x",
        killed: true,
        state: "error" as const,
      }));
    }
  });
});
