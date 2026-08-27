import { describe, it, expect, mock, beforeEach } from "bun:test";

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
const readRunOutputMock = mock(async (_runId: string, _opts: { offset?: number }) => ({
  chunk: "",
  nextOffset: 0,
  eof: true,
}));
let listRunsResponse: Record<string, unknown> = {};
const listRunsMock = mock(async () => listRunsResponse);
const sendToRunMock = mock(async () => ({
  delivered: true,
  status: "delivered" as const,
  steerFile: "/tmp/x",
  pendingBytes: 0,
  waitedMs: 10,
}));
const sweepRunsMock = mock(async () => ({ expired: [], reasons: {}, removed: [], killed: [] }));
const sessionIdOfRunMock = mock(async () => null);

let ownRunIdsImpl: (() => string[]) | undefined = () => ["run-own-aaa"];
const ownRunIdsMock = mock(() => (ownRunIdsImpl ? ownRunIdsImpl() : ([] as string[])));

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
  get ownRunIds() {
    return ownRunIdsImpl === undefined ? undefined : ownRunIdsMock;
  },
  pollRun: async () => ({ runId: "run-1", state: "running" as const, envelope: null, exitCode: null }),
  renewLease: async () => new Date(Date.now() + 60_000).toISOString(),
  parseModelSpec,
  formatModelSpec,
  ModelSpecError,
}));

// must import extension AFTER mock.module: важен сам побочный эффект загрузки,
// экспорт по умолчанию этому файлу не нужен.
await import("./index.ts");
import { clearRunsBoardStateForTest, filterOwnRuns } from "./ui.ts";

function makeCtx() {
  const widgets: Array<{ key: string; value: unknown }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const ctx: any = {
    ui: {
      setWidget(key: string, value: unknown) {
        widgets.push({ key, value });
      },
      setStatus(key: string, value: unknown) {
        statuses.push({ key, value });
      },
    },
    setInterval(_cb: () => void, _ms: number) {
      // не запускаем реальный интервал на тестах виджета
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    },
    clearTimer() {},
  };
  return { ctx, widgets, statuses };
}

async function tickViaContext(ctx: any): Promise<void> {
  // Пробуждаем rememberRunsCtx → tick() через оба пути: session_start и ctx.ui
  // Чтобы не зависеть от внутреннего экспорта tick, гоним через публичные хуки.
  // dshTaskExtension подписывается на session_start/context, а каждый тул ещё зовёт rememberRunsCtx.
  // Проще — прямой вызов тула dsh_list который сам вызывает rememberRunsCtx → tick.
  const zodMod = await import("@oh-my-pi/omptype/zod");
  const _z = (zodMod as any).z ?? (zodMod as any).default ?? zodMod;
  // вызов через установленный мост: listRuns → tick() должен отфильтровать
  // Используем dsh_spawn-путь для rememberRunsCtx: дергаем execute dsh_list
  // Получим pi с зареганными тулами из предыдущего импорта extension — надо пересоздать pi.
  // Чтобы не плодить обёрток, зовём напрямую ui-модуль через повторный тик: вызываем ctx через dshTaskExtension повторно?
  // Упростим: напрямую импортируем ui и вызываем rememberRunsCtx + ждём микрозадачу.
  const ui = await import("./ui.ts");
  ui.rememberRunsCtx(ctx as any);
  // tick() — async, ждём его завершения
  await new Promise((r) => setTimeout(r, 30));
}

describe("widget ownership filter: ui.ts tick filters by ownRunIds", () => {
  beforeEach(() => {
    clearRunsBoardStateForTest();
    listRunsResponse = {};
    ownRunIdsMock.mockClear();
    listRunsMock.mockClear();
    // по умолчанию возвращаем к функциональному ownRunIds
    ownRunIdsImpl = () => ["run-own-aaa"];
  });

  it("свой ран показывается", async () => {
    const now = new Date().toISOString();
    listRunsResponse = {
      "run-own-aaa": { pid: 1, pgid: 1, state: "running", startedAt: now, label: "own" },
    };
    ownRunIdsImpl = () => ["run-own-aaa"];

    const { ctx, widgets } = makeCtx();
    await tickViaContext(ctx);
    // виджет должен быть установлен (factory)
    const set = widgets.find((w) => w.key === "dsh-runs" && w.value !== undefined);
    expect(set, "own run должен отрисовать виджет").toBeDefined();
    // вызов factory с темой должен содержать метку
    if (!set) throw new Error("виджет dsh-runs не установлен");
    const factory = set.value as (tui: unknown, theme: unknown) => unknown;
    expect(typeof factory).toBe("function");
    const theme = {
      fg: (_c: string, t: string) => t,
      styledSymbol: (k: string, _c: string) => k,
      sep: { dot: " · " },
      tree: { last: "└" },
      spinnerFrames: ["⠋"],
    };
    const comp: any = factory(null, theme as any);
    const text: string = comp.getText ? comp.getText() : String(comp);
    expect(text).toContain("own");
  });

  it("чужой ран не показывается, и виджет скрывается когда своих нет", async () => {
    const now = new Date().toISOString();
    listRunsResponse = {
      "run-foreign-bbb": { pid: 2, pgid: 2, state: "running", startedAt: now, label: "foreign" },
    };
    ownRunIdsImpl = () => ["run-own-aaa"];

    const { ctx, widgets } = makeCtx();
    await tickViaContext(ctx);
    // должен быть вызов hide (undefined)
    const hides = widgets.filter((w) => w.key === "dsh-runs" && w.value === undefined);
    expect(hides.length).toBeGreaterThan(0);
    // при этом не должно быть установленного виджета с factory содержащим foreign
    const shown = widgets.find((w) => w.key === "dsh-runs" && typeof w.value === "function");
    if (shown) {
      const factory = shown.value as (tui: unknown, theme: unknown) => unknown;
      const theme = {
        fg: (_c: string, t: string) => t,
        styledSymbol: (k: string, _c: string) => k,
        sep: { dot: " · " },
        tree: { last: "└" },
        spinnerFrames: ["⠋"],
      };
      const comp: any = (factory as any)(null, theme as any);
      const text: string = comp.getText ? comp.getText() : String(comp);
      expect(text).not.toContain("foreign");
    }
  });

  // Guard-ветка проверяется на filterOwnRuns, а не через tick(): ownRunIds приходит в ui.ts
  // статическим ESM-импортом, и «убрать» его из уже загруженного теста нельзя — Bun резолвит
  // биндинг один раз при импорте, даже когда mock.module отдаёт геттер (проверено: при
  // ownRunIdsImpl=undefined мок всё равно отдавал функцию, фильтр срабатывал и виджет гас).
  // Прежняя версия этого теста обходила проблему grep'ом по исходнику ui.ts плюс собственной
  // копией тернарника — она зеленела бы и с удалённым ui.ts, а падала от смены кавычек.
  describe("filterOwnRuns — источник ownRunIds как параметр", () => {
    const entries = [
      { runId: "run-foreign-bbb", label: "foreign", state: "running", startedAt: "" },
      { runId: "run-own-aaa", label: "own", state: "running", startedAt: "" },
    ];

    it("без ownRunIds (не функция) показываются все — без фильтра (guard)", () => {
      const out = filterOwnRuns(entries, undefined);
      expect(out.map((e) => e.label)).toEqual(["foreign", "own"]);
    });

    it("с ownRunIds остаются только свои", () => {
      const out = filterOwnRuns(entries, () => ["run-own-aaa"]);
      expect(out.map((e) => e.label)).toEqual(["own"]);
    });

    it("падение ownRunIds не роняет тик и не прячет борд", () => {
      const out = filterOwnRuns(entries, () => {
        throw new Error("bridge down");
      });
      expect(out.map((e) => e.label)).toEqual(["foreign", "own"]);
    });
  });

  describe("filterOwnRuns — липкость stickyOwnRunIds", () => {
    const mkEntry = (runId: string) => ({ runId, label: runId, state: "running", startedAt: "" });

    it("свой ран остаётся виден после того, как ownRunIds перестал его отдавать", () => {
      clearRunsBoardStateForTest();
      const entries = [mkEntry("run-sticky-1"), mkEntry("run-foreign-s1")];
      let own: string[] = ["run-sticky-1"];
      // первый вызов: own() отдаёт ран, тот виден
      expect(filterOwnRuns(entries, () => own).map((e) => e.runId)).toEqual(["run-sticky-1"]);
      // второй вызов: own() уже не отдаёт ран — но ран остаётся виден (липкость)
      own = [];
      expect(filterOwnRuns(entries, () => own).map((e) => e.runId)).toEqual(["run-sticky-1"]);
    });

    it("чужой не появляется никогда, даже если ownRunIds однажды вернул пусто", () => {
      clearRunsBoardStateForTest();
      const entries = [mkEntry("run-foreign-s2"), mkEntry("run-own-s2")];
      // собственные ответы own() пусты — чужого нет в результате
      expect(filterOwnRuns(entries, () => []).map((e) => e.runId)).toEqual([]);
      expect(filterOwnRuns(entries, () => []).map((e) => e.runId)).toEqual([]);
      // а когда own() отдаёт только своё — виден только свой, чужой по-прежнему нет
      expect(filterOwnRuns(entries, () => ["run-own-s2"]).map((e) => e.runId)).toEqual(["run-own-s2"]);
    });

    it("множество не протекает после clearRunsBoardStateForTest", () => {
      clearRunsBoardStateForTest();
      const entries = [mkEntry("run-clear-s3")];
      // ран стал липким через ответ own()
      expect(filterOwnRuns(entries, () => ["run-clear-s3"]).map((e) => e.runId)).toEqual(["run-clear-s3"]);
      // очистка сбрасывает липкость: пока own() его снова не отдала — рана в борде нет
      clearRunsBoardStateForTest();
      expect(filterOwnRuns(entries, () => []).map((e) => e.runId)).toEqual([]);
      // и он возвращается ровно в момент, когда own() снова его отдаёт
      expect(filterOwnRuns(entries, () => ["run-clear-s3"]).map((e) => e.runId)).toEqual(["run-clear-s3"]);
    });
  });
});
