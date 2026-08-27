// Интеграция dsh_task ↔ настоящий bridge-core: тул поверх реального spawn, без заглушек.
//
// Файл намеренно НЕ называется *.test.ts и лежит вне дефолтного паттерна bun test:
// index.test.ts подменяет "../../tools/dsh-bridge/src/index.js" через mock.module,
// а тот глобален для тестового процесса и переподвязывает уже импортированный
// extension. Перебить мок изнутри файла нельзя — нужен отдельный процесс.
// Запуск: `bun test extensions/dsh-task/integration.bridge.ts` (см. package.json).
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import dshTaskExtension from "./index.ts";

const BRIDGE_DIR = join(import.meta.dir, "..", "..", "tools", "dsh-bridge");
const FIXTURE_DSH = join(BRIDGE_DIR, "test", "fixtures", "dsh");

/**
 * Отдаёт тул ПО ИМЕНИ: extension регистрирует несколько тулов, и брать
 * последний зарегистрированный (как было) — значит молча тестировать не тот.
 */
async function makeTool(name = "dsh_task") {
  const zodMod = await import("@oh-my-pi/omptype/zod");
  const z = (zodMod as any).z ?? (zodMod as any).default ?? zodMod;
  const tools = new Map<string, any>();
  const pi: any = {
    zod: z,
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    // dshTaskExtension заодно регистрирует /dvibe (registerDvibe); эти интеграционные
    // кейсы гоняют только dsh_*-тулы против реального bridge, но без стабов
    // registerCommand/on/getActiveTools/setActiveTools сам dshTaskExtension(pi)
    // падает раньше, чем доходит до регистрации тулов.
    registerCommand() {},
    on() {},
    getActiveTools() {
      return [];
    },
    async setActiveTools() {},
  };
  dshTaskExtension(pi);
  const tool = tools.get(name);
  if (!tool) throw new Error(`тул ${name} не зарегистрирован; есть: ${[...tools.keys()].join(", ")}`);
  return tool;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Изолирует бинарь dsh и реестр ранов на время одного кейса. */
async function withEnv(binary: string): Promise<{ cwd: string; registryPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-task-it-"));
  const registryPath = join(cwd, "runs.json");
  const prevBin = process.env.DSH_BINARY;
  const prevReg = process.env.DSH_BRIDGE_RUNS_FILE;
  process.env.DSH_BINARY = binary;
  process.env.DSH_BRIDGE_RUNS_FILE = registryPath;
  cleanups.push(async () => {
    if (prevBin === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = prevBin;
    if (prevReg === undefined) delete process.env.DSH_BRIDGE_RUNS_FILE;
    else process.env.DSH_BRIDGE_RUNS_FILE = prevReg;
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, registryPath };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

describe("dsh_task ↔ bridge-core (integration)", () => {
  it("completed: реальный spawn, результат доходит до тула", async () => {
    const tool = await makeTool();
    const { cwd } = await withEnv(FIXTURE_DSH);

    const res: any = await tool.execute("call-1", { task: "hello integration" }, undefined, undefined, { cwd });

    expect(res.isError).toBeFalsy();
    expect(res.details.status).toBe("completed");
    expect(res.content[0].text).toContain("hello integration");
  });

  it("стриминг: onUpdate получает вывод настоящего процесса", async () => {
    const tool = await makeTool();
    const { cwd } = await withEnv(FIXTURE_DSH);

    const updates: string[] = [];
    const res: any = await tool.execute(
      "call-2",
      { task: "streamed line" },
      undefined,
      (u: any) => updates.push(u.content[0].text),
      { cwd },
    );

    expect(res.details.status).toBe("completed");
    expect(updates.join("\n")).toContain("streamed line");
  });

  it("need_input: envelope от dsh пробрасывается как вопрос", async () => {
    const tool = await makeTool();
    const { cwd } = await withEnv(FIXTURE_DSH);

    const res: any = await tool.execute(
      "call-3",
      { task: "__FAKE_ENVELOPE_NEED_INPUT__ уточни" },
      undefined,
      undefined,
      { cwd },
    );

    expect(res.details.status).toBe("need_input");
    expect(res.content[0].text.length).toBeGreaterThan(0);
    expect(res.isError).toBeFalsy();
  });

  it("exit≠0: тул отдаёт isError и код причины", async () => {
    const tool = await makeTool();
    const { cwd } = await withEnv(FIXTURE_DSH);

    const res: any = await tool.execute("call-4", { task: "__FAKE_EXIT1__" }, undefined, undefined, { cwd });

    expect(res.isError).toBe(true);
    expect(res.details.status).toBe("error");
    expect(res.details.error.code).toBe("nonzero_exit");
  });

  it("отсутствующий бинарь: spawn_failed, не зависание", async () => {
    const tool = await makeTool();
    const { cwd } = await withEnv("/nonexistent/dsh-binary-xyz");

    const res: any = await tool.execute("call-5", { task: "whatever" }, undefined, undefined, { cwd });

    expect(res.isError).toBe(true);
    expect(res.details.error.code).toBe("spawn_failed");
  });

  // --- Неблокирующие тулы поверх настоящего core (контракт v2) ---

  it("dsh_spawn не ждёт, dsh_wait дожидается envelope", async () => {
    const spawnTool = await makeTool("dsh_spawn");
    const waitTool = await makeTool("dsh_wait");
    const { cwd } = await withEnv(FIXTURE_DSH);

    const started: any = await spawnTool.execute("s-1", { task: "async hello" }, undefined, undefined, { cwd });
    expect(started.isError).toBeFalsy();
    const runId: string = started.details.runId;
    expect(runId.length).toBeGreaterThan(0);

    const done: any = await waitTool.execute("w-1", { runId, waitMs: 10000 }, undefined, undefined, { cwd });
    expect(done.isError).toBeFalsy();
    expect(done.details.status).toBe("completed");
    expect(done.content[0].text).toContain("async hello");
  }, 20000);

  it("dsh_wait по таймауту не ошибка: ран жив и дожидается со второй попытки", async () => {
    const spawnTool = await makeTool("dsh_spawn");
    const waitTool = await makeTool("dsh_wait");
    const killTool = await makeTool("dsh_kill");
    const { cwd, registryPath } = await withEnv(FIXTURE_DSH);

    const started: any = await spawnTool.execute("s-2", { task: "__FAKE_HANG__" }, undefined, undefined, { cwd });
    const runId: string = started.details.runId;
    const pid: number = started.details.pid;

    const early: any = await waitTool.execute("w-2", { runId, waitMs: 300 }, undefined, undefined, { cwd });
    expect(early.isError).toBeFalsy();
    expect(early.details.state).toBe("running");
    expect(isAlive(pid), "истёкшее ожидание не должно трогать ран").toBe(true);

    const killed: any = await killTool.execute("k-2", { runId }, undefined, undefined, { cwd });
    expect(killed.isError).toBeFalsy();

    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid), "после dsh_kill процесс мёртв").toBe(false);
    // Запись не удаляется: она переходит в терминальное состояние и хранит
    // исход (чистит её reapOrphans). Иначе после kill исход было бы не узнать.
    const reg = JSON.parse(await readFile(registryPath, "utf8"));
    expect(reg[runId]?.state, "запись должна выйти из running").not.toBe("running");
    expect(typeof reg[runId]?.exitCode, "исход должен сохраниться").toBe("number");
  }, 25000);

  it("AbortSignal у dsh_wait отменяет только ожидание, ран продолжает жить", async () => {
    const spawnTool = await makeTool("dsh_spawn");
    const waitTool = await makeTool("dsh_wait");
    const killTool = await makeTool("dsh_kill");
    const { cwd } = await withEnv(FIXTURE_DSH);

    const started: any = await spawnTool.execute("s-3", { task: "__FAKE_HANG__" }, undefined, undefined, { cwd });
    const runId: string = started.details.runId;
    const pid: number = started.details.pid;

    const ac = new AbortController();
    const pending = waitTool.execute("w-3", { runId, waitMs: 10000 }, ac.signal, undefined, { cwd });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const res: any = await pending;

    expect(res.isError).toBeFalsy();
    expect(isAlive(pid), "отмена ожидания НЕ должна убивать ран").toBe(true);

    await killTool.execute("k-3", { runId }, undefined, undefined, { cwd });
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(false);
  }, 25000);

  it("dsh_send: без читателя, пока ран жив — status:pending (НЕ ошибка); к завершённому — undeliverable (ошибка)", async () => {
    // P1 п.4, раунд 2 кросс-ревью: трёхзначный status заменил бинарный
    // delivered — delivered:true раньше давался сразу после appendFile, а
    // потом стал честным (см. дефект 2), но delivered:false смешивал ДВЕ
    // разные ситуации в одну. Живой ран без читателя — чтение не
    // подтверждено, это pending, НЕ ошибка вызывающего; завершённый ран —
    // сообщение потеряно навсегда, это undeliverable, ошибка.
    const spawnTool = await makeTool("dsh_spawn");
    const sendTool = await makeTool("dsh_send");
    const killTool = await makeTool("dsh_kill");
    const { cwd, registryPath } = await withEnv(FIXTURE_DSH);

    const started: any = await spawnTool.execute("s-4", { task: "__FAKE_HANG__" }, undefined, undefined, { cwd });
    const runId: string = started.details.runId;

    const sent: any = await sendTool.execute("m-1", { runId, text: "не туда копаешь" }, undefined, undefined, { cwd });
    expect(sent.isError, "ран был жив при повторной проверке — это НЕ ошибка вызывающего").toBeFalsy();
    expect(sent.details.status).toBe("pending");
    expect(sent.details.delivered).toBe(false);
    expect(sent.content[0].text).toContain("do NOT resend");

    // Сообщение всё равно легло в канал строкой JSONL — просто его не прочитали.
    const raw = await readFile(sent.details.steerFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).text).toBe("не туда копаешь");

    // Фикстура канал не читает, поэтому непрочитанное видно вызывающему, и
    // sendToRun реально прождал окно доставки, а не соврал мгновенно.
    expect(sent.details.pendingBytes).toBeGreaterThan(0);
    expect(sent.details.waitedMs).toBeGreaterThan(0);

    await killTool.execute("k-4", { runId }, undefined, undefined, { cwd });
    await new Promise((r) => setTimeout(r, 300));

    const late: any = await sendTool.execute("m-2", { runId, text: "поздно" }, undefined, undefined, { cwd });
    expect(late.isError, "в завершённый ран доставки уже не будет — это ошибка, а не тихий успех").toBe(true);
    expect(late.details.status).toBe("undeliverable");
    expect(late.details.delivered).toBe(false);
    expect(late.content[0].text).toContain("message lost");
    expect(late.details.waitedMs, "завершённый ран отсекается ДО ожидания — ждать нечего").toBe(0);

    const reg = JSON.parse(await readFile(registryPath, "utf8"));
    expect(reg[runId]?.steerFile, "steerFile должен быть записан в реестр").toBeTruthy();
  }, 25000);

  it("dsh_send: status:delivered, когда раннер реально читает канал", async () => {
    const spawnTool = await makeTool("dsh_spawn");
    const sendTool = await makeTool("dsh_send");
    const killTool = await makeTool("dsh_kill");
    const { cwd } = await withEnv(FIXTURE_DSH);

    const started: any = await spawnTool.execute("s-4b", { task: "__FAKE_STEER_READER__" }, undefined, undefined, {
      cwd,
    });
    const runId: string = started.details.runId;

    const sent: any = await sendTool.execute("m-1b", { runId, text: "услышано" }, undefined, undefined, { cwd });
    expect(sent.isError).toBeFalsy();
    expect(sent.details.status).toBe("delivered");
    expect(sent.details.delivered).toBe(true);
    expect(sent.content[0].text).toBe(`sent to ${runId}`);

    await killTool.execute("k-4b", { runId }, undefined, undefined, { cwd });
    await new Promise((r) => setTimeout(r, 300));
  }, 25000);

  it("cancellation: AbortSignal убивает группу, сирот и записей в реестре не остаётся", async () => {
    const tool = await makeTool();
    const { cwd, registryPath } = await withEnv(FIXTURE_DSH);

    const ac = new AbortController();
    const pending = tool.execute("call-6", { task: "__FAKE_SPAWN_CHILD__" }, ac.signal, undefined, { cwd });

    // Ждём появления записи в реестре, чтобы узнать pid реального процесса.
    let entry: any = null;
    for (let i = 0; i < 100 && !entry; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const reg = JSON.parse(await readFile(registryPath, "utf8"));
        entry = Object.values(reg)[0] ?? null;
      } catch {
        /* реестра ещё нет */
      }
    }
    expect(entry, "ран должен зарегистрироваться").not.toBeNull();
    const pid: number = entry.pid;

    ac.abort();
    const res: any = await pending;

    expect(res.isError).toBe(true);
    expect(res.details.status).toBe("error");

    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid), `процесс ${pid} должен быть убит`).toBe(false);

    const reg = JSON.parse(await readFile(registryPath, "utf8"));
    expect(Object.keys(reg)).toEqual([]);
  }, 20000);
});
