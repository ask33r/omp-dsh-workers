import { describe, it, expect } from "bun:test";
import { formatRunsBoard, formatRunsStatus, formatElapsed, shortId } from "./ui.ts";

type StubTheme = {
  fg: (c: string, t: string) => string;
  bold: (t: string) => string;
  styledSymbol: (k: string, c: string) => string;
  sep: { dot: string };
  tree: { last: string; branch: string; vertical: string; horizontal: string; hook: string };
  format: { bracketLeft: string; bracketRight: string };
  spinnerFrames: string[];
};
const stubTheme: StubTheme = {
  fg: (_c, t) => t,
  bold: (t) => t,
  styledSymbol: (k, _c) => k,
  sep: { dot: " · " },
  tree: { last: "└", branch: "├", vertical: "│", horizontal: "─", hook: "└" },
  format: { bracketLeft: "⟨", bracketRight: "⟩" },
  spinnerFrames: ["⠋"],
};

type BoardInput = Parameters<typeof formatRunsBoard>[0];
type StatusInput = Parameters<typeof formatRunsStatus>[0];

function hasCyrillic(s: string): boolean {
  return /[а-яА-ЯёЁ]/.test(s);
}

describe("formatRunsBoard", () => {
  it("empty registry -> [] (panel removed)", () => {
    expect(
      formatRunsBoard(
        [] as unknown as BoardInput,
        Date.now(),
        undefined,
        stubTheme as unknown as Parameters<typeof formatRunsBoard>[3],
      ),
    ).toEqual([]);
    expect(
      formatRunsBoard(
        {} as unknown as BoardInput,
        Date.now(),
        undefined,
        stubTheme as unknown as Parameters<typeof formatRunsBoard>[3],
      ),
    ).toEqual([]);
  });

  it("no header or separator, single line per run", () => {
    const now = Date.parse("2026-08-25T12:00:30.000Z");
    const startedAt = "2026-08-25T12:00:00.000Z";
    const runs = [{ runId: "abcdefgh-1234-5678", state: "running", startedAt, label: null }] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines.length).toBe(1);
    expect(lines.join("\n")).not.toContain("dsh runs");
    expect(lines.join("\n")).not.toContain("─".repeat(20));
    expect(hasCyrillic(lines.join(" "))).toBe(false);
  });

  it("one running without label uses short runId and status icon", () => {
    const now = Date.parse("2026-08-25T12:00:30.000Z");
    const startedAt = "2026-08-25T12:00:00.000Z";
    const runs = [{ runId: "abcdefgh-1234-5678", state: "running", startedAt, label: null }] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    const line = lines[0];
    expect(line).toContain("status.running");
    expect(line).toContain("abcdefgh");
    expect(line).not.toContain("abcdefgh-1234-5678");
    expect(line).toContain("running");
    expect(line).toContain("30s");
    expect(hasCyrillic(line)).toBe(false);
  });

  it("running with label shows label and model without duplicated runId", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const runs = [
      {
        runId: "run-label-1234567890",
        label: "worker-a",
        state: "running",
        startedAt: "2026-08-25T12:00:00.000Z",
        model: { provider: "omniroute", model: "foo", reasoningEffort: "high" },
      },
    ] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    const line = lines[0];
    expect(line).toContain("worker-a");
    expect(line).toContain("omniroute/foo:high");
    expect(hasCyrillic(line)).toBe(false);
  });

  it("steer delivered -> second line with steer time, preview truncated 60 and delivered", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const runs = [
      { runId: "run-1", label: "w1", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const steers = new Map([["run-1", { text: "hello delivered", time: now, status: "delivered" as const }]]);
    const lines = formatRunsBoard(runs, now, steers, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines.length).toBe(2);
    const steerLine = lines[1];
    expect(steerLine).toContain("steer");
    expect(steerLine).toContain("hello delivered");
    expect(steerLine).toContain("delivered");
    expect(steerLine).toContain("└");
    expect(steerLine).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(hasCyrillic(steerLine)).toBe(false);
  });

  it("steer pending -> English pending", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const runs = [
      { runId: "run-1", label: "w1", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const steers = new Map([["run-1", { text: "hello pending", time: now, status: "pending" as const }]]);
    const lines = formatRunsBoard(runs, now, steers, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines[1]).toContain("pending");
    expect(lines[1].toLowerCase()).not.toContain("будет");
    expect(hasCyrillic(lines[1])).toBe(false);
  });

  it("steer undeliverable -> English not delivered", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const runs = [
      { runId: "run-1", label: "w1", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const steers = new Map([["run-1", { text: "lost msg", time: now, status: "undeliverable" as const }]]);
    const lines = formatRunsBoard(runs, now, steers, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines[1]).toContain("not delivered");
    expect(hasCyrillic(lines[1])).toBe(false);
  });

  it("steer preview truncated to 60 chars", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const long = "x".repeat(200);
    const runs = [
      { runId: "run-1", label: "w1", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const steers = new Map([["run-1", { text: long, time: now, status: "delivered" as const }]]);
    const lines = formatRunsBoard(runs, now, steers, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    const steerLine = lines[1];
    expect(steerLine).toContain("…");
    expect(hasCyrillic(steerLine)).toBe(false);
  });

  it("done entries use status.done icon", () => {
    const now = Date.parse("2026-08-25T12:00:30.000Z");
    const runs = [
      { runId: "run-1", label: null, state: "completed", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines[0]).toContain("status.done");
  });

  it("error and need_input use correct icons", () => {
    const now = Date.parse("2026-08-25T12:00:30.000Z");
    const runs = [
      { runId: "r1", label: null, state: "error", startedAt: "2026-08-25T12:00:00.000Z" },
      { runId: "r2", label: null, state: "need_input", startedAt: "2026-08-25T12:00:00.000Z" },
    ] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines[0]).toContain("status.error");
    expect(lines[1]).toContain("status.warning");
  });

  it("elapsed formatting for minutes and hours via shared helper", () => {
    const base = Date.parse("2026-08-25T10:00:00.000Z");
    const runs = [
      { runId: "r1", state: "running", startedAt: "2026-08-25T10:00:00.000Z", label: null },
    ] as unknown as BoardInput;
    const line90s = formatRunsBoard(
      runs,
      base + 90_000,
      undefined,
      stubTheme as unknown as Parameters<typeof formatRunsBoard>[3],
    )[0];
    expect(line90s).toContain("1m 30s");
    const line2h = formatRunsBoard(
      runs,
      base + 2 * 3600_000 + 5 * 60_000,
      undefined,
      stubTheme as unknown as Parameters<typeof formatRunsBoard>[3],
    )[0];
    expect(line2h).toContain("2h");
    expect(formatElapsed("2026-08-25T10:00:00.000Z", base + 90_000)).toBe("1m 30s");
  });

  it("model truncated to 30 chars with ellipsis", () => {
    const now = Date.parse("2026-08-25T12:00:10.000Z");
    const runs = [
      {
        runId: "run-1",
        label: "w1",
        state: "running",
        startedAt: "2026-08-25T12:00:00.000Z",
        model: { provider: "omniroute", model: "a".repeat(50) },
      },
    ] as unknown as BoardInput;
    const lines = formatRunsBoard(runs, now, undefined, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    expect(lines[0]).toContain("…");
    expect(hasCyrillic(lines[0])).toBe(false);
  });

  it("no Russian words anywhere", () => {
    const now = Date.now();
    const runs = [
      {
        runId: "run-1",
        label: "worker-a",
        state: "running",
        startedAt: new Date(now - 5000).toISOString(),
        model: { provider: "p", model: "m" },
      },
      { runId: "run-2", label: null, state: "completed", startedAt: new Date(now - 10000).toISOString() },
    ] as unknown as BoardInput;
    const steers = new Map([["run-1", { text: "hello world", time: now, status: "pending" as const }]]);
    const lines = formatRunsBoard(runs, now, steers, stubTheme as unknown as Parameters<typeof formatRunsBoard>[3]);
    const all = lines.join(" ");
    expect(all).not.toMatch(/[а-яА-ЯёЁ]/);
    expect(all).not.toContain("окно");
    expect(all).not.toContain("будет прочитано");
  });

  it("helpers shortId and display", () => {
    expect(shortId("abcdefgh-123456")).toBe("abcdefgh");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("formatRunsStatus", () => {
  it("empty -> undefined", () => {
    expect(
      formatRunsStatus([] as unknown as StatusInput, stubTheme as unknown as Parameters<typeof formatRunsStatus>[1]),
    ).toBeUndefined();
    expect(
      formatRunsStatus({} as unknown as StatusInput, stubTheme as unknown as Parameters<typeof formatRunsStatus>[1]),
    ).toBeUndefined();
  });

  it("counts running vs done without colon", () => {
    const runs = [
      { runId: "a", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
      { runId: "b", state: "completed", startedAt: "2026-08-25T12:00:01.000Z" },
      { runId: "c", state: "error", startedAt: "2026-08-25T12:00:02.000Z" },
    ] as unknown as StatusInput;
    const status = formatRunsStatus(runs, stubTheme as unknown as Parameters<typeof formatRunsStatus>[1]);
    expect(status).toBe("dsh 1 running · 2 done");
    expect(status).not.toContain("dsh:");
    expect(hasCyrillic(status ?? "")).toBe(false);
  });

  it("record variant with object map", () => {
    const runs = {
      a: { pid: 1, state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
      b: { pid: 2, state: "running", startedAt: "2026-08-25T12:00:01.000Z" },
    } as unknown as StatusInput;
    expect(formatRunsStatus(runs, stubTheme as unknown as Parameters<typeof formatRunsStatus>[1])).toBe(
      "dsh 2 running · 0 done",
    );
  });

  it("uses theme sep dot", () => {
    const customTheme = { ...stubTheme, sep: { dot: " | " } } as unknown as Parameters<typeof formatRunsStatus>[1];
    const runs = [
      { runId: "a", state: "running", startedAt: "2026-08-25T12:00:00.000Z" },
      { runId: "b", state: "completed", startedAt: "2026-08-25T12:00:01.000Z" },
    ] as unknown as StatusInput;
    const status = formatRunsStatus(runs, customTheme);
    expect(status).toContain(" | ");
  });
});
