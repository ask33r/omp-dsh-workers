import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { THINKING_LEVELS } from "../../tools/dsh-bridge/src/model-spec.js";

type ModelSpec = { provider: string; model: string; reasoningEffort?: string };

// Срез ExtensionContext, нужный для наследования роли: `models.resolve` (@dsh) и `model` (fallback).
export type RoleCtx = {
  models?: { resolve: (spec: string) => { provider: string; id: string } | undefined };
  model?: { provider: string; id: string } | undefined;
};

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function readRoleRaw(
  agentDir: string,
  role = "dsh",
  readFile?: (path: string) => string | undefined,
): string | undefined {
  const read =
    readFile ??
    ((p: string): string | undefined => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });
  let text: string | undefined = read(join(agentDir, "config.yml"));
  if (text === undefined) text = read(join(agentDir, "config.yaml"));
  if (typeof text !== "string") return undefined;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let blockIndent: number | null = null;
  for (const rawLine of lines) {
    if (!inBlock) {
      const m = rawLine.match(/^(\s*)modelRoles:\s*$/);
      if (m) {
        inBlock = true;
        blockIndent = m[1].length;
      }
      continue;
    }
    // inside modelRoles block
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
    if (blockIndent !== null && indent <= blockIndent) break;
    const kv = rawLine.match(/^\s*([^:\s#]+)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    if (key !== role) continue;
    let value = kv[2].trim();
    // drop trailing comment not inside quotes
    // if value is quoted, comment after closing quote is not part of value — handle simple case
    if ((value.startsWith('"') && value.includes('"', 1)) || (value.startsWith("'") && value.includes("'", 1))) {
      const q = value[0];
      const end = value.indexOf(q, 1);
      if (end !== -1) {
        value = value.slice(0, end + 1);
      }
    } else {
      const hashIdx = value.indexOf("#");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    value = stripQuotes(value);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function effortOfRoleRaw(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return undefined;
  const suffix = raw.slice(idx + 1);
  if (THINKING_LEVELS.has(suffix)) return suffix;
  return undefined;
}

export function resolveRoleModel(
  ctx: RoleCtx,
  opts?: { agentDir?: string; readFile?: (path: string) => string | undefined; getAgentDir?: () => string },
): ModelSpec | undefined {
  let agentDir: string | undefined = opts?.agentDir;
  if (!agentDir) {
    try {
      const fn = opts?.getAgentDir ?? getAgentDir;
      agentDir = fn();
    } catch {
      agentDir = undefined;
    }
  }
  let raw: string | undefined;
  if (agentDir) {
    try {
      raw = readRoleRaw(agentDir, "dsh", opts?.readFile);
    } catch {
      raw = undefined;
    }
  }
  // Шаг 1: модель и effort происходят из ОДНОГО текста. resolve("@dsh") отдаёт алиас,
  // закешированный хостом со старта сессии; raw читается с диска свежим чтением. При
  // смене роли на лету (A:high → B:max) они рассинхронизируются и дают связку, которой
  // пользователь не задавал никогда. Поэтому: снимаем с raw валидный суффикс effort,
  // базу (строку без ":effort") отдаём в ctx.models.resolve(база).
  let m: { provider: string; id: string } | undefined;
  let fromRole = false;
  if (raw !== undefined) {
    const effort = effortOfRoleRaw(raw);
    const base = effort ? raw.slice(0, raw.length - effort.length - 1) : raw;
    try {
      m = ctx?.models?.resolve?.(base);
      fromRole = m !== undefined;
    } catch {
      m = undefined;
    }
    if (m) return makeSpec(m, effort);
  }
  // Шаг 2: raw нет на диске ИЛИ база не резолвится → fallback на закешированный
  // алиас "@dsh". Effort роли законен, пока provider/id приходят именно от него.
  if (!m) {
    try {
      m = ctx?.models?.resolve?.("@dsh");
      fromRole = m !== undefined;
    } catch {
      m = undefined;
    }
  }
  // Шаг 3: и алиас не резолвится → текущая модель сессии БЕЗ effort:
  // суффикс роли к ней отношения не имеет.
  if (!m) m = ctx?.model as { provider: string; id: string } | undefined;
  if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || m.provider.length === 0 || m.id.length === 0)
    return undefined;
  return makeSpec(m, fromRole ? effortOfRoleRaw(raw) : undefined);
}

function makeSpec(m: { provider: string; id: string }, effort?: string): ModelSpec {
  const spec: ModelSpec = effort
    ? { provider: m.provider, model: m.id, reasoningEffort: effort }
    : { provider: m.provider, model: m.id };
  return spec;
}
