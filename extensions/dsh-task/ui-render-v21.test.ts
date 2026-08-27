import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";

const runDshMock = mock(async () => ({ v: 1, runId: "run-1", sessionId: null, status: "completed", result: "hello" }));
const startDshMock = mock(async () => ({
  runId: "run-spawn-1",
  pid: 4242,
  pgid: 4242,
  logFile: "/tmp/x.log",
  startedAt: new Date().toISOString(),
  label: "worker-a",
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

import { parseModelSpec, formatModelSpec } from "../../tools/dsh-bridge/src/model-spec.js";
import { ModelSpecError } from "../../tools/dsh-bridge/src/model-spec.js";

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
  formatModelSpec,
  parseModelSpec,
  ModelSpecError,
}));

const { default: dshTaskExtension } = await import("./index.ts");
import { rememberRunLabel, labelOf, clearRunLabelsForTest } from "./ui.ts";

type StubTheme = {
  fg: (color: string, text: string) => string;
  styledSymbol: (key: string, color: string) => string;
  sep: { dot: string };
  tree: { last: string; branch: string };
  format: { bracketLeft: string; bracketRight: string };
  spinnerFrames: string[];
};

const stubTheme: StubTheme = {
  fg: (_c, t) => t,
  styledSymbol: (k, _c) => k,
  sep: { dot: " · " },
  tree: { last: "└", branch: "├" },
  format: { bracketLeft: "⟨", bracketRight: "⟩" },
  spinnerFrames: ["⠋", "⠙", "⠹"],
};

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
        renderCall: (a: unknown, o: unknown, t: unknown) => unknown;
        renderResult: (r: unknown, o: unknown, t: unknown, a?: unknown) => unknown;
      } & Record<string, unknown>
    >,
  };
}

function textOf(comp: unknown): string {
  if (comp instanceof Text) return (comp as Text).getText();
  return String(comp);
}

// (a) наличие mergeCallAndResult === true у пяти тулов
describe("v2.1: mergeCallAndResult", () => {
  it("все пять DSH-тулов имеют mergeCallAndResult === true", async () => {
    const { tools } = await makePiAsync();
    for (const name of ["dsh_spawn", "dsh_wait", "dsh_send", "dsh_kill", "dsh_list"]) {
      const t = tools[name] as unknown as Record<string, unknown>;
      expect(t.mergeCallAndResult, `${name} mergeCallAndResult`).toBe(true);
    }
  });
});

// (b) renderCall dsh_wait со spinnerFrame: 0 начинается со спиннера, без — с status.pending
describe("v2.1: dsh_wait renderCall spinner", () => {
  it("со spinnerFrame:0 — спиннер, без — status.pending", async () => {
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const withSpinner = textOf(
      tool.renderCall(
        { runId: "run-abc12345678" },
        { expanded: false, isPartial: true, spinnerFrame: 0 } as unknown as Record<string, unknown>,
        stubTheme,
      ),
    );
    expect(withSpinner.startsWith("⠋") || withSpinner.startsWith("⠙") || withSpinner.includes("⠋")).toBe(true);
    // без spinnerFrame — pending
    const without = textOf(
      tool.renderCall(
        { runId: "run-abc12345678" },
        { expanded: false, isPartial: false, spinnerFrame: undefined } as unknown as Record<string, unknown>,
        stubTheme,
      ),
    );
    expect(without).toContain("status.pending");
  });
});

// (c) labelOf после rememberRunLabel и после dsh_list
describe("v2.1: label memory", () => {
  beforeEach(() => {
    clearRunLabelsForTest();
  });

  it("labelOf после rememberRunLabel возвращает метку, иначе runId8", async () => {
    expect(labelOf("run-abc12345678")).toBe("run-abc1");
    rememberRunLabel("run-abc12345678", "worker-a");
    expect(labelOf("run-abc12345678")).toBe("worker-a");
  });

  it("labelOf после dsh_list registry", async () => {
    clearRunLabelsForTest();
    const { tools } = await makePiAsync();
    // dsh_list execute должен пополнить память; вызываем с реестром содержащим label
    // tick() из rememberRunsCtx тоже зовёт listRuns — нужно отдать реестр обоим вызовам,
    // иначе mockImplementationOnce съест первый (tick) и execute получит пустой реестр.
    // После фильтра ui.ts (ownRunIds) tick может отфильтровать, но execute сам помнит label без фильтра.
    const reg = {
      "run-zzzz11112222": { pid: 1, pgid: 1, state: "running", startedAt: new Date().toISOString(), label: "alpha" },
    } as unknown as Record<string, unknown>;
    listRunsMock.mockImplementationOnce(async () => reg);
    listRunsMock.mockImplementationOnce(async () => reg);
    const t = tools.dsh_list as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    await t.execute("id", {}, undefined, undefined, { cwd: "/tmp", ui: {} } as unknown as never);
    expect(labelOf("run-zzzz11112222")).toBe("alpha");
  });
});

// (d) dsh_wait renderCall/renderResult показывают метку после rememberRunLabel
describe("v2.1: dsh_wait shows label", () => {
  beforeEach(() => {
    clearRunLabelsForTest();
  });

  it("renderCall и renderResult показывают labelOf(runId), runId8 в meta когда есть метка", async () => {
    const { tools } = await makePiAsync();
    rememberRunLabel("run-abc12345678", "worker-a");
    const tool = tools.dsh_wait;
    const callText = textOf(
      tool.renderCall(
        { runId: "run-abc12345678" },
        { expanded: false, isPartial: false } as unknown as Record<string, unknown>,
        stubTheme,
      ),
    );
    expect(callText).toContain("worker-a");
    expect(callText).toContain("run-abc1");

    const env = {
      v: 1,
      runId: "run-abc12345678",
      sessionId: "session-xxxx",
      status: "completed",
      result: "OK",
      model: null,
    };
    const resultText = textOf(
      tool.renderResult(
        {
          content: [{ type: "text", text: "OK" }],
          details: { runId: "run-abc12345678", state: "completed", envelope: env, exitCode: 0 } as unknown as Record<
            string,
            unknown
          >,
        },
        { expanded: false, isPartial: false } as unknown as Record<string, unknown>,
        stubTheme,
      ),
    );
    expect(resultText).toContain("worker-a");
  });

  it("без метки — только runId8 в заголовке, без дубля в meta (dsh_wait)", async () => {
    clearRunLabelsForTest();
    const { tools } = await makePiAsync();
    const tool = tools.dsh_wait;
    const callText = textOf(
      tool.renderCall(
        { runId: "run-abc12345678" },
        { expanded: false, isPartial: false } as unknown as Record<string, unknown>,
        stubTheme,
      ),
    );
    // без метки заголовок содержит runId8
    expect(callText).toContain("run-abc1");
    // не должно дублировать runId8 дважды в meta — call meta содержит только elapsed, не runId8
    // проверяем что runId8 встречается ровно 1 раз (в заголовке)
    const count = (callText.match(/run-abc1/g) ?? []).length;
    expect(count).toBe(1);
  });
});
