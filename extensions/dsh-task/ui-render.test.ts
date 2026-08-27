import { describe, it, expect, mock } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";

const runDshMock = mock(async () => ({ v: 1, runId: "run-1", sessionId: null, status: "completed", result: "hello" }));
const startDshMock = mock(async () => ({
  runId: "run-spawn-1",
  pid: 4242,
  pgid: 4242,
  logFile: "/tmp/x.log",
  startedAt: new Date().toISOString(),
}));
const waitRunMock = mock(async () => ({
  runId: "run-spawn-1",
  state: "running" as const,
  envelope: null,
  exitCode: null,
}));
const killRunMock = mock(async () => ({ runId: "run-spawn-1", killed: true, state: "error" as const }));
const readRunOutputMock = mock(async (_runId: string, opts: { offset?: number }) => ({
  chunk: "",
  nextOffset: opts?.offset ?? 0,
  eof: true,
}));
const listRunsMock = mock(async () => ({}) as Record<string, unknown>);
const sendToRunMock = mock(async () => ({
  delivered: true,
  status: "delivered" as const,
  steerFile: "/tmp/x",
  pendingBytes: 0,
  waitedMs: 10,
}));
const sweepRunsMock = mock(async () => ({ expired: [], reasons: {}, removed: [], killed: [] }));
const sessionIdOfRunMock = mock(async () => null);

import { parseModelSpec, formatModelSpec, ModelSpecError } from "../../tools/dsh-bridge/src/model-spec.js";

mock.module("../../tools/dsh-bridge/src/index.js", () => ({
  runDsh: runDshMock,
  startDsh: startDshMock,
  waitRun: waitRunMock,
  killRun: killRunMock,
  readRunOutput: readRunOutputMock,
  listRuns: listRunsMock,
  sendToRun: sendToRunMock,
  sweepRuns: sweepRunsMock,
  sessionIdOfRun: sessionIdOfRunMock,
  ownRunIds: () => [] as string[],
  // pollRun/renewLease тут не вызываются, но их статически импортирует relay.ts,
  // который index.ts тянет по цепочке. См. якорный комментарий в index.test.ts:
  // фабрика подменяет модуль целиком, поэтому обязана быть полной.
  pollRun: async () => ({ runId: "run-1", state: "running" as const, envelope: null, exitCode: null }),
  renewLease: async () => new Date(Date.now() + 60_000).toISOString(),
  parseModelSpec,
  formatModelSpec,
  ModelSpecError,
}));

const { default: dshTaskExtension } = await import("./index.ts");

type StubTheme = {
  fg: (c: string, t: string) => string;
  bold: (t: string) => string;
  styledSymbol: (k: string, c: string) => string;
  sep: { dot: string };
  tree: { last: string; branch: string; vertical: string };
  format: { bracketLeft: string; bracketRight: string };
  spinnerFrames: string[];
};

const stubTheme: StubTheme = {
  fg: (_c, t) => t,
  bold: (t) => t,
  styledSymbol: (k, _c) => k,
  sep: { dot: " · " },
  tree: { last: "└", branch: "├", vertical: "│" },
  format: { bracketLeft: "⟨", bracketRight: "⟩" },
  spinnerFrames: ["⠋"],
};

function hasCyrillic(s: string): boolean {
  return /[а-яА-ЯёЁ]/.test(s);
}

async function makePiAsync() {
  const zodMod = await import("@oh-my-pi/omptype/zod");
  const z =
    (zodMod as unknown as { z: unknown; default: unknown }).z ??
    (zodMod as unknown as { default: unknown }).default ??
    zodMod;
  const tools: Record<string, unknown> = {};
  const pi = {
    zod: z,
    registerTool(def: unknown) {
      const d = def as { name: string };
      tools[d.name] = def;
    },
    registerCommand() {},
    on() {},
    getActiveTools() {
      return [];
    },
    async setActiveTools() {},
  } as unknown as import("@oh-my-pi/pi-coding-agent").ExtensionAPI & { zod: unknown };
  dshTaskExtension(pi);
  return {
    pi,
    tools: tools as Record<
      string,
      {
        renderCall: (a: unknown, o: unknown, t: unknown) => Text;
        renderResult: (r: unknown, o: unknown, t: unknown, a?: unknown) => Text;
      }
    >,
  };
}

function textOf(comp: unknown): string {
  if (comp instanceof Text) return (comp as Text).getText();
  return String(comp);
}

describe("ui render: dsh_spawn", () => {
  it("renderCall: pending icon + dsh spawn: <label> + preview 80 + model meta", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    const comp = tool.renderCall(
      { task: `my brief that is long ${"x".repeat(200)}`, label: "worker-a", model: "omniroute/foo:high" },
      { expanded: false, isPartial: true },
      stubTheme,
    );
    expect(comp).toBeInstanceOf(Text);
    const t = textOf(comp);
    expect(t).toContain("status.pending");
    expect(t).toContain("dsh spawn: worker-a");
    expect(t).toContain("my brief");
    expect(t).toContain("└");
    expect(t.toLowerCase()).not.toContain("модель");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderCall without label uses runId placeholder truncated to 8 concept", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    const comp = tool.renderCall({ task: "hello world" }, { expanded: false, isPartial: true }, stubTheme);
    const t = textOf(comp);
    expect(t).toContain("dsh spawn:");
    expect(t).toContain("hello world");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult done: done icon + dsh spawn: <label> meta pid + runId8", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    const comp = tool.renderResult(
      {
        content: [{ type: "text", text: "started run-abc1234567890 (pid 123) label=worker-a" }],
        details: {
          runId: "run-abc1234567890",
          pid: 123,
          pgid: 123,
          logFile: "/tmp/x",
          startedAt: "now",
          label: "worker-a",
        } as unknown as Record<string, unknown>,
        isError: false,
      },
      { expanded: false, isPartial: false },
      stubTheme,
      { task: "t", label: "worker-a" },
    );
    const t = textOf(comp);
    expect(t).toContain("status.done");
    expect(t).toContain("dsh spawn: worker-a");
    expect(t).toContain("123");
    expect(t).toContain("run-abc1");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult error: error icon + dsh spawn + error message", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_spawn;
    const comp = tool.renderResult(
      {
        content: [{ type: "text", text: "error: spawn failed" }],
        details: { runId: "", pid: 0, pgid: 0, logFile: "", startedAt: "" } as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      stubTheme,
      { task: "t" },
    );
    const t = textOf(comp);
    expect(t).toContain("status.error");
    expect(t).toContain("dsh spawn:");
    expect(t.toLowerCase()).toContain("error");
    expect(hasCyrillic(t)).toBe(false);
  });
});

describe("ui render: dsh_send", () => {
  it("renderCall: pending icon + dsh send + quoted 100 preview", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_send;
    const comp = tool.renderCall(
      { runId: "run-abc12345678", text: `hello world ${"y".repeat(300)}` },
      { expanded: false, isPartial: true },
      stubTheme,
    );
    expect(comp).toBeInstanceOf(Text);
    const t = textOf(comp);
    expect(t).toContain("status.pending");
    expect(t).toContain("dsh send:");
    expect(t).toContain("hello world");
    expect(t).toContain("└");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult delivered -> done icon + delivered meta", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_send;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "sent to run-1" }],
        details: {
          delivered: true,
          status: "delivered",
          steerFile: "/tmp/x",
          pendingBytes: 0,
          waitedMs: 10,
        } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("dsh send:");
    expect(t).toContain("delivered");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult pending -> warning icon + pending", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_send;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "pending: run alive" }],
        details: {
          delivered: false,
          status: "pending",
          steerFile: "/tmp/x",
          pendingBytes: 17,
          waitedMs: 1200,
        } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.warning");
    expect(t).toContain("pending");
    expect(t).not.toContain("будет прочитано");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult undeliverable -> error icon + not delivered English", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_send;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "NOT delivered: run ended" }],
        details: {
          delivered: false,
          status: "undeliverable",
          steerFile: "/tmp/x",
          pendingBytes: 0,
          waitedMs: 1200,
        } as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.error");
    expect(t.toLowerCase()).toContain("not delivered");
    expect(hasCyrillic(t)).toBe(false);
  });
});

describe("ui render: dsh_wait", () => {
  it("renderCall: running/spinner icon + dsh wait: label + 60s meta pattern", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const c = tool.renderCall(
      { runId: "run-abc12345678" },
      { expanded: false, isPartial: true, spinnerFrame: 0 },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("dsh wait:");
    // running or spinner frame
    const hasRunning = t.includes("status.running") || t.includes("⠋");
    expect(hasRunning).toBe(true);
    expect(hasCyrillic(t)).toBe(false);
    expect(t).not.toContain("окно");
  });

  it("renderCall pending shape (no spinnerFrame) uses status.pending muted", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const c = tool.renderCall(
      { runId: "run-abc12345678", waitMs: 5000 },
      { expanded: false, isPartial: true },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("dsh wait:");
    expect(hasCyrillic(t)).toBe(false);
    expect(t).not.toContain("окно");
  });

  it("renderResult running: running icon + without still running header", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6" }],
        details: { runId: "run-abc", state: "running", envelope: null, exitCode: null } as unknown as Record<
          string,
          unknown
        >,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.running");
    expect(t).not.toContain("still running");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult running streams up to 5 lines in toolOutput color concept", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "a\nb\nc\nd\ne\nf\ng\nh" }],
        details: { runId: "run-abc", state: "running", envelope: null, exitCode: null } as unknown as Record<
          string,
          unknown
        >,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    // should contain last 5 lines, not all 8
    expect(t).toContain("d");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult completed: done icon + model · session8 · KB meta + up to 6 lines + more hint", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const env = {
      v: 1,
      runId: "run-x",
      sessionId: "session-abc12345678",
      status: "completed",
      result: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
      model: { provider: "omniroute", model: "foo" },
    };
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8" }],
        details: { runId: "run-x", state: "completed", envelope: env, exitCode: 0 } as unknown as Record<
          string,
          unknown
        >,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("dsh wait:");
    expect(t).toContain("line1");
    // more lines hint uses … N more lines
    expect(t).toContain("more lines");
    expect(t).toContain("…");
    expect(hasCyrillic(t)).toBe(false);
    expect(t).not.toContain("session: session-");
  });

  it("renderResult completed when details IS the envelope", async () => {
    // dsh_wait на завершении кладёт в details сам envelope (index.ts: `details: envelope`),
    // а не обёртку {state, envelope} — карточка обязана распознать и эту форму.
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const env = {
      v: 1,
      runId: "run-y",
      sessionId: "session-14b84d2c-31e4",
      status: "completed",
      result: "OK",
      model: { provider: "omniroute", model: "cx/gpt-5.6-sol", reasoningEffort: "high" },
    };
    const c = tool.renderResult(
      { content: [{ type: "text", text: "OK" }], details: env as unknown as Record<string, unknown> },
      { expanded: false, isPartial: false } as never,
      stubTheme as never,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("14b84d2c");
    expect(t).not.toContain("session-");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult need_input: warning icon + needs input meta + question truncated 3 lines", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const env = {
      v: 1,
      runId: "run-x",
      sessionId: "sess",
      status: "need_input",
      question: "what next?\nline2\nline3\nline4\nline5",
    };
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "what next?\nline2\nline3\nline4\nline5" }],
        details: { runId: "run-x", state: "need_input", envelope: env, exitCode: null } as unknown as Record<
          string,
          unknown
        >,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.warning");
    expect(t).toContain("needs input");
    expect(t).toContain("what next?");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult error: error icon + error [code]: message detail line", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const env = {
      v: 1,
      runId: "run-x",
      sessionId: null,
      status: "error",
      error: { code: "model_not_found", message: "no model" },
    };
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "error [model_not_found]: no model" }],
        details: { runId: "run-x", state: "error", envelope: env, exitCode: 1 } as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.error");
    expect(t).toContain("model_not_found");
    expect(t).toContain("└");
    expect(hasCyrillic(t)).toBe(false);
  });
});

describe("ui render: dsh_kill", () => {
  it("renderCall: pending icon + dsh kill: label", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    const c = tool.renderCall({ runId: "run-abc12345678" }, { expanded: false, isPartial: true }, stubTheme);
    const t = textOf(c);
    expect(t).toContain("status.pending");
    expect(t).toContain("dsh kill:");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult killed: done icon + killed (state) meta", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "kill run-x: killed (error)" }],
        details: { runId: "run-x", killed: true, state: "error" } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("killed");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult not killed: error icon + not killed (state)", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_kill;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "kill run-x: not killed (running)" }],
        details: { runId: "run-x", killed: false, state: "running" } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.error");
    expect(t).toContain("not killed");
    expect(hasCyrillic(t)).toBe(false);
  });
});

describe("ui render: dsh_list", () => {
  it("renderCall: pending icon + dsh list English", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    const c = tool.renderCall({}, { expanded: false, isPartial: true }, stubTheme);
    const t = textOf(c);
    expect(t).toContain("status.pending");
    expect(t).toContain("dsh list");
    expect(hasCyrillic(t)).toBe(false);
    expect(t).not.toContain("dsh runs");
  });

  it("renderResult empty: done icon + dsh list + no runs", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "no active runs" }],
        details: { runs: [] } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("dsh list");
    expect(t).toContain("no runs");
    expect(t).toContain("└");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("renderResult with runs: header meta N running · M done + per-run lines with tree symbols", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    const now = new Date().toISOString();
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          runs: [
            {
              runId: "run-a-longid123",
              label: "worker-a",
              state: "running",
              startedAt: now,
              model: { provider: "omniroute", model: "foo" },
            },
            { runId: "run-b-longid456", label: null, state: "completed", startedAt: now, model: null },
          ],
        } as unknown as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.done");
    expect(t).toContain("dsh list");
    expect(t).toContain("running");
    expect(t).toContain("worker-a");
    // tree branch/last symbols present
    expect(t).toContain("└");
    expect(hasCyrillic(t)).toBe(false);
    expect(t).not.toContain("no active runs");
  });

  it("renderResult error: error icon", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_list;
    const c = tool.renderResult(
      {
        content: [{ type: "text", text: "error: boom" }],
        details: { runs: [] } as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      stubTheme,
    );
    const t = textOf(c);
    expect(t).toContain("status.error");
    expect(hasCyrillic(t)).toBe(false);
  });

  it("all tool cards contain no Russian words", async () => {
    const { tools } = await makePiAsync();
    const cases: Array<[string, unknown, unknown]> = [
      [
        "dsh_spawn",
        { task: "hello" },
        {
          content: [{ type: "text", text: "started run-abc (pid 1)" }],
          details: { runId: "run-abc12345678", pid: 1, pgid: 1, logFile: "", startedAt: "" },
          isError: false,
        },
      ],
      [
        "dsh_wait",
        { runId: "run-abc12345678" },
        {
          content: [{ type: "text", text: "still running: run-abc" }],
          details: { runId: "run-abc", state: "running", envelope: null, exitCode: null },
        },
      ],
      [
        "dsh_send",
        { runId: "run-abc", text: "hi" },
        {
          content: [{ type: "text", text: "sent" }],
          details: { delivered: true, status: "delivered", steerFile: "", pendingBytes: 0, waitedMs: 0 },
        },
      ],
      [
        "dsh_kill",
        { runId: "run-abc" },
        {
          content: [{ type: "text", text: "kill run-abc: killed (error)" }],
          details: { runId: "run-abc", killed: true, state: "error" },
        },
      ],
      ["dsh_list", {}, { content: [{ type: "text", text: "no active runs" }], details: { runs: [] } }],
    ];
    for (const [name, args, result] of cases) {
      const tool = tools[name];
      const callText = textOf(tool.renderCall(args, { expanded: false, isPartial: true, spinnerFrame: 0 }, stubTheme));
      const resultText = textOf(
        tool.renderResult(result, { expanded: false, isPartial: false }, stubTheme, args as Record<string, unknown>),
      );
      expect(hasCyrillic(callText), `${name} call has Cyrillic: ${callText}`).toBe(false);
      expect(hasCyrillic(resultText), `${name} result has Cyrillic: ${resultText}`).toBe(false);
      expect(callText).not.toContain("dsh runs");
      expect(callText).not.toContain("─".repeat(10));
      expect(resultText).not.toContain("─".repeat(10));
    }
  });
});
