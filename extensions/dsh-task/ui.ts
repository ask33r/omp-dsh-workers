import { Text } from "@oh-my-pi/pi-tui";
// Theme живёт в pi-coding-agent (modes/theme), а не в pi-tui: у pi-tui только
// частные темы отдельных компонентов (SymbolTheme, MarkdownTheme и т.п.).
import type { ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { listRuns as bridgeListRuns, formatModelSpec, ownRunIds } from "../../tools/dsh-bridge/src/index.js";

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
export function shortId(id: string): string {
  if (!id) return "";
  return id.length <= 8 ? id : id.slice(0, 8);
}

// Память сессии runId → label (хэндoфф v2.1, задача 2): заполняется из dsh_spawn (details.label),
// из каждого dsh_list (реестр) и из тика панели; используется рендерами dsh_wait/dsh_send/dsh_kill.
const runLabels = new Map<string, string>();

export function rememberRunLabel(runId: string, label: string): void {
  if (typeof runId !== "string" || runId.length === 0) return;
  if (typeof label !== "string" || label.trim().length === 0) return;
  runLabels.set(runId, label.trim());
}

export function labelOf(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0) return "";
  const lab = runLabels.get(runId);
  if (typeof lab === "string" && lab.length > 0) return lab;
  return shortId(runId);
}

export function clearRunLabelsForTest(): void {
  runLabels.clear();
}

function displayLabel(entry: { runId: string; label?: string | null }): string {
  const label = entry.label;
  if (typeof label === "string" && label.length > 0) return label;
  return shortId(entry.runId);
}

function isModelSpec(m: unknown): m is { provider: string; model: string; reasoningEffort?: string } {
  if (!m || typeof m !== "object") return false;
  const rec = m as Record<string, unknown>;
  return typeof rec.provider === "string" && typeof rec.model === "string";
}

function formatEntryModel(m: unknown): string {
  if (!isModelSpec(m)) return "default";
  try {
    const s = formatModelSpec(m);
    return s.length > 30 ? `${s.slice(0, 29)}…` : s;
  } catch {
    return "default";
  }
}

export function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "?";
  const diff = Math.max(0, now - start);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m}m ${String(remS).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${String(remM).padStart(2, "0")}m` : `${h}h`;
}

function formatHHMMSS(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function iconForState(state: string, theme?: unknown, spinnerFrame?: number): string {
  const t = theme as unknown as Theme | undefined;
  const hasTheme = Boolean(t && typeof (t as unknown as { styledSymbol?: unknown }).styledSymbol === "function");
  if (state === "running" || state === "pending") {
    if (hasTheme) {
      const th = t as Theme;
      if (typeof spinnerFrame === "number" && Array.isArray(th.spinnerFrames) && th.spinnerFrames.length > 0) {
        return th.spinnerFrames[spinnerFrame % th.spinnerFrames.length];
      }
      return th.styledSymbol("status.running", "accent");
    }
    return "●";
  }
  if (state === "completed") {
    if (hasTheme) return (t as Theme).styledSymbol("status.done", "success");
    return "✓";
  }
  if (state === "error" || state === "killed") {
    if (hasTheme) return (t as Theme).styledSymbol("status.error", "error");
    return "✗";
  }
  if (state === "need_input") {
    if (hasTheme) return (t as Theme).styledSymbol("status.warning", "warning");
    return "❓";
  }
  if (hasTheme) return (t as Theme).styledSymbol("status.running", "accent");
  return "●";
}

export type RunBoardEntry = {
  runId: string;
  label?: string | null;
  state: string;
  startedAt: string;
  model?: unknown;
  [key: string]: unknown;
};

export type SteerInfo = {
  text: string;
  time: number;
  status: "delivered" | "pending" | "undeliverable";
};

export function formatRunsBoard(
  runs: Record<string, RunBoardEntry> | RunBoardEntry[],
  now: number,
  steers?: Map<string, SteerInfo>,
  theme?: unknown,
): string[] {
  const list: RunBoardEntry[] = Array.isArray(runs)
    ? runs
    : Object.entries(runs as Record<string, RunBoardEntry>).map(([runId, entry]) => {
        const e = entry as RunBoardEntry;
        if (e && typeof e.runId === "string" && e.runId.length > 0) return e;
        return { ...e, runId };
      });

  const normalized: RunBoardEntry[] = list
    .filter((e) => e !== null && typeof e === "object" && typeof (e as RunBoardEntry).runId === "string")
    .map((e) => ({
      ...e,
      label: (e as RunBoardEntry).label ?? null,
      state: (e as RunBoardEntry).state ?? "running",
      startedAt: (e as RunBoardEntry).startedAt ?? new Date(now).toISOString(),
      model: (e as RunBoardEntry).model ?? null,
    }));

  if (normalized.length === 0) return [];

  normalized.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const t = theme as unknown as Theme | undefined;
  const dot: string = (t?.sep?.dot as string) ?? " · ";
  const treeLast: string = (t?.tree?.last as string) ?? "└";
  const fg = (color: string, text: string): string => {
    if (t && typeof t.fg === "function") return t.fg(color as never, text);
    return text;
  };

  const lines: string[] = [];
  for (const entry of normalized) {
    const icon = iconForState(entry.state, theme);
    const label = displayLabel(entry);
    const elapsed = formatElapsed(entry.startedAt, now);
    const modelStr = formatEntryModel(entry.model);
    const meta = `${entry.state}${dot}${elapsed}${dot}${modelStr}`;
    lines.push(`${icon} ${label} ${fg("dim", meta)}`);
    const steer = steers?.get(entry.runId);
    if (steer) {
      const timeStr = formatHHMMSS(steer.time);
      const preview = truncate(oneLine(steer.text), 60);
      const previewQuoted = `“${preview}”`;
      let statusStr: string;
      let statusColor: string;
      if (steer.status === "delivered") {
        statusStr = "delivered";
        statusColor = "success";
      } else if (steer.status === "pending") {
        statusStr = "pending";
        statusColor = "warning";
      } else {
        statusStr = "not delivered";
        statusColor = "error";
      }
      const dimPart = fg("dim", `${treeLast} steer ${timeStr} ${previewQuoted}`);
      const statusPart = t && typeof t.fg === "function" ? t.fg(statusColor as never, statusStr) : statusStr;
      const dotDim = fg("dim", dot);
      lines.push(`${dimPart}${dotDim}${statusPart}`);
    }
  }
  return lines;
}

export function formatRunsStatus(
  runs: Record<string, RunBoardEntry> | RunBoardEntry[],
  theme?: unknown,
): string | undefined {
  const t = theme as unknown as Theme | undefined;
  const dot: string = (t?.sep?.dot as string) ?? " · ";
  const entries: RunBoardEntry[] = Array.isArray(runs)
    ? (runs as RunBoardEntry[]).filter(
        (e) => e !== null && typeof e === "object" && typeof (e as RunBoardEntry).runId === "string",
      )
    : Object.entries(runs as Record<string, RunBoardEntry>)
        .map(([runId, entry]) => {
          const e = entry as RunBoardEntry;
          if (e && typeof e.runId === "string" && e.runId.length > 0) return e;
          return { ...e, runId };
        })
        .filter((e) => typeof e.runId === "string");

  const effective = entries;
  if (effective.length === 0) {
    const raw = Array.isArray(runs) ? (runs as unknown[]) : Object.values(runs as Record<string, unknown>);
    if (raw.length === 0) return undefined;
    const total = raw.length;
    let running = 0;
    for (const r of raw as Array<Record<string, unknown>>) {
      if (r && typeof r.state === "string" && r.state === "running") running++;
    }
    const done = total - running;
    return `dsh ${running} running${dot}${done} done`;
  }
  const total = effective.length;
  let running = 0;
  for (const r of effective) {
    if (r.state === "running") running++;
  }
  const done = total - running;
  return `dsh ${running} running${dot}${done} done`;
}

const WIDGET_KEY = "dsh-runs";
const STATUS_KEY = "dsh-runs";
const POLL_MS = 1000;

let lastCtx: ExtensionContext | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const steersMap = new Map<string, SteerInfo>();

function stopPolling(): void {
  if (pollTimer === null) return;
  try {
    if (lastCtx !== null && typeof (lastCtx as unknown as Record<string, unknown>).clearTimer === "function") {
      const clearTimer = (lastCtx as unknown as { clearTimer: (t: unknown) => void }).clearTimer;
      clearTimer(pollTimer);
    } else {
      clearInterval(pollTimer);
    }
  } catch {
    try {
      clearInterval(pollTimer);
    } catch {}
  }
  pollTimer = null;
}

function ensurePolling(): void {
  if (pollTimer !== null) return;
  if (lastCtx === null) return;
  const ctxForTimer = lastCtx;
  const maybeSetInterval = (ctxForTimer as unknown as Record<string, unknown>).setInterval;
  if (typeof maybeSetInterval === "function") {
    const setIntervalFn = maybeSetInterval as (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
    pollTimer = setIntervalFn(() => {
      void tick();
    }, POLL_MS);
  } else {
    pollTimer = setInterval(() => {
      void tick();
    }, POLL_MS);
    const maybeUnref = (pollTimer as unknown as Record<string, unknown>).unref;
    if (typeof maybeUnref === "function") {
      (maybeUnref as () => void).call(pollTimer);
    }
  }
}

const stickyOwnRunIds = new Set<string>();

/**
 * Виджет — про раны ЭТОЙ сессии. Реестр общий на все сессии OMP, и без фильтра борд светил
 * чужой работой в каждой новой сессии того же каталога (найдено живьём владельцем: ран одной
 * сессии висел в UI всех остальных сразу при старте).
 *
 * Отдельная экспортируемая функция, а не ветка внутри tick(), именно ради теста guard'а:
 * `ownRunIds` приходит в ui.ts статическим ESM-импортом, и подменить его на «не функцию»
 * из уже загруженного теста нельзя — Bun резолвит биндинг один раз при импорте, даже когда
 * mock.module отдаёт геттер. Пока фильтр жил внутри tick(), эта ветка была непокрываема
 * поведением, и тест на неё выродился в grep по исходнику (зелёный с удалённым ui.ts,
 * красный от смены кавычек). Здесь источник ownRunIds — параметр, и все три случая
 * проверяются вызовом.
 *
 * Липкость: ownRunIds() отдаёт только живые старты (!closed), поэтому свой завершившийся
 * ран пропадал из борда мгновенно, не доживая до выметания реестра. Ран, хоть раз
 * замеченный в ownRunIds(), добавляется в липкое множество и остаётся там; фильтр
 * проверяет множество, а не текущий ответ. Чужой в множество не попадёт никогда —
 * он не бывает в ownRunIds().
 *
 * @param own — bridge.ownRunIds; не функция (замоканный мост) → фильтра нет, старое поведение.
 */
export function filterOwnRuns(entries: RunBoardEntry[], own: unknown): RunBoardEntry[] {
  if (typeof own !== "function") return entries;
  try {
    const ids = (own as () => string[])();
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) stickyOwnRunIds.add(id);
    }
    return entries.filter((e) => stickyOwnRunIds.has(e.runId));
  } catch {
    // Отказ моста не повод ронять тик. Показываем список как есть: борд диагностический,
    // и пустой борд при живом ране дезориентирует сильнее, чем лишняя строка.
    return entries;
  }
}

async function tick(): Promise<void> {
  const ctx = lastCtx;
  if (ctx === null) return;
  try {
    const registry = (await bridgeListRuns()) as unknown as Record<string, RunBoardEntry>;
    let entries: RunBoardEntry[] = Object.entries(registry).map(([runId, entry]) => {
      const e = entry as RunBoardEntry;
      if (e && typeof e.runId === "string" && e.runId.length > 0) return e;
      return { ...(e as Record<string, unknown>), runId } as RunBoardEntry;
    });
    entries = filterOwnRuns(entries, ownRunIds);
    for (const e of entries) {
      if (typeof e.label === "string" && e.label.length > 0) rememberRunLabel(e.runId, e.label);
    }
    if (entries.length === 0) {
      try {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {}
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {}
      stopPolling();
      return;
    }
    const now = Date.now();
    const status = formatRunsStatus(entries);
    const widgetFactory = (_tui: unknown, theme: Theme): Text => {
      const lines = formatRunsBoard(entries, now, steersMap, theme);
      return new Text(lines.join("\n"), 0, 0);
    };
    try {
      ctx.ui.setWidget(WIDGET_KEY, widgetFactory as unknown as never, { placement: "aboveEditor" });
    } catch {
      const fallbackTheme = {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        styledSymbol: (k: string, _c: string) => k,
        sep: { dot: " · " },
        tree: { last: "└", branch: "├", vertical: "│", horizontal: "─", hook: "└" },
        format: { bracketLeft: "⟨", bracketRight: "⟩" },
        spinnerFrames: ["⠋"],
      } as unknown as Theme;
      const lines = formatRunsBoard(entries, now, steersMap, fallbackTheme);
      try {
        ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
      } catch {}
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, status);
    } catch {}
    ensurePolling();
  } catch {}
}

export function rememberRunsCtx(ctx: ExtensionContext): void {
  lastCtx = ctx;
  void tick();
}

export function recordSteer(runId: string, text: string, status: SteerInfo["status"]): void {
  steersMap.set(runId, { text, time: Date.now(), status });
  if (lastCtx !== null) void tick();
}

export function clearRunsBoardStateForTest(): void {
  stopPolling();
  steersMap.clear();
  stickyOwnRunIds.clear();
  lastCtx = null;
}

export function installRunsBoard(pi: ExtensionAPI): void {
  try {
    pi.on("session_start", (_ev: unknown, ctx: ExtensionContext) => {
      rememberRunsCtx(ctx);
    });
  } catch {}
  try {
    pi.on("session_shutdown", (_ev: unknown, ctx: ExtensionContext) => {
      const c: ExtensionContext | null = (ctx as ExtensionContext) ?? lastCtx;
      const target: ExtensionContext | null = c ?? lastCtx;
      if (target !== null) {
        try {
          target.ui.setWidget(WIDGET_KEY, undefined);
        } catch {}
        try {
          target.ui.setStatus(STATUS_KEY, undefined);
        } catch {}
      } else if (lastCtx !== null) {
        try {
          lastCtx.ui.setWidget(WIDGET_KEY, undefined);
        } catch {}
        try {
          lastCtx.ui.setStatus(STATUS_KEY, undefined);
        } catch {}
      }
      stopPolling();
      steersMap.clear();
      stickyOwnRunIds.clear();
      lastCtx = (c as ExtensionContext) ?? null;
    });
  } catch {}
}
