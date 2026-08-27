import { describe, it, expect } from "bun:test";
// dvibe.ts не должен зависеть от bridge (см. index.ts) — импортируем только его,
// без mock.module: тут нечего мокать, режим директора не трогает dsh-bridge.
import { registerDvibe } from "./dvibe.ts";

// Реальный zod нужен тулу dvibe (П.C): registerDvibe зовёт pi.zod.object/enum при
// регистрации — заглушка `{}` уронила бы сам вызов registerDvibe(pi).
const zodMod = (await import("@oh-my-pi/omptype/zod")) as unknown as { z?: unknown; default?: unknown };
const zReal = (zodMod.z ?? zodMod.default ?? zodMod) as never;

/**
 * Мок ExtensionAPI — только то, что реально использует dvibe.ts: registerCommand,
 * registerTool (тул dvibe, П.C), on, getActiveTools/setActiveTools, zod.
 */
function makePi(initialActiveTools: string[]) {
  let activeTools = [...initialActiveTools];
  const setActiveToolsCalls: string[][] = [];
  const commands: Record<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  const tools: Record<string, any> = {};

  const pi: any = {
    zod: zReal,
    registerCommand(name: string, opts: any) {
      commands[name] = opts;
    },
    registerTool(def: any) {
      tools[def.name] = def;
    },
    getActiveTools() {
      return activeTools;
    },
    async setActiveTools(names: string[]) {
      setActiveToolsCalls.push(names);
      activeTools = names;
    },
    on(event: string, handler: any) {
      handlers[event] = handler;
    },
  };

  return { pi, commands, handlers, setActiveToolsCalls, tools };
}

function makeCtx() {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx: any = {
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, notifications };
}

// Не полный целевой набор — часть обязательных тулов (dsh_answer, dvibe) в нём
// отсутствует, чтобы проверить, что вход в режим директора их ДОБАВЛЯЕТ, а не
// просто фильтрует прежний список.
const NORMAL_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "glob",
  "grep",
  "todo",
  "task",
  "dsh_task",
  "dsh_spawn",
  "dsh_wait",
  "dsh_send",
  "dsh_kill",
  "dsh_list",
];
const EXPECTED_DIRECTOR_TOOLS = [
  "read",
  "todo",
  "dsh_spawn",
  "dsh_send",
  "dsh_wait",
  "dsh_list",
  "dsh_kill",
  "dsh_answer",
  "dvibe",
];

describe("dvibe: вход в режим директора", () => {
  it("setActiveTools вызван директорским набором (kept из прежнего списка + добавленные dsh_answer/dvibe)", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("", ctx);

    expect(setActiveToolsCalls).toHaveLength(1);
    expect(setActiveToolsCalls[0]).toEqual(EXPECTED_DIRECTOR_TOOLS);
  });

  // П.5 (drop-llm-representative): hub и task спавна представителей выпилены из
  // набора целиком — режим директора их больше не тянет ни в каком виде.
  it("директорский набор не содержит hub/task", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("", ctx);

    expect(setActiveToolsCalls[0]).not.toContain("hub");
    expect(setActiveToolsCalls[0]).not.toContain("task");
  });

  it("уведомляет о входе через ctx.ui.notify", async () => {
    const { pi, commands } = makePi(NORMAL_TOOLS);
    const { ctx, notifications } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("on", ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("director");
  });
});

describe("dvibe: before_agent_start", () => {
  it("при включённом режиме дописывает директиву, не заменяя переданный systemPrompt", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);

    const base = ["BASE-1", "BASE-2"];
    const result: any = await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: base,
    });

    expect(result).toBeDefined();
    // исходные элементы сохранены и НЕ заменены — только дописаны.
    expect(result.systemPrompt.slice(0, 2)).toEqual(base);
    expect(result.systemPrompt).toHaveLength(3);
    const directive = result.systemPrompt[2] as string;
    expect(directive).toContain("director");
    expect(directive).toContain("need_input");
    expect(directive).toContain("dsh_list");
    // детерминированный steering/чтение результата директором (задача C): метка
    // (по label), delivered:true как сигнал "уже в ране" — вместо переспроса модели.
    expect(directive).toContain("by label");
    expect(directive).toContain("delivered:true");
    // модель исполнителя (хэндофф C): нотация, модель роли @dsh наследует исполнитель, resume не липкий, коды ошибок
    expect(directive).toContain("executor model");
    expect(directive).toContain("model");
    expect(directive).toContain("not sticky");
    expect(directive).toContain("model_not_found");
    // представитель-скрипт (relay): директор шлёт брифы сам через dsh_spawn
    expect(directive).toContain("dsh_spawn");
    expect(directive).toContain("dsh_answer");
    expect(directive).toContain("label parameter");
    // П.D-2 (ре-смоук 2026-08-26): «когда результат нужен прямо сейчас» модель трактует
    // расширительно и зовёт dsh_wait первым же действием после спавна. Критерий и
    // анти-паттерн должны быть названы явно, вместе с ценой ожидания.
    expect(directive).toContain("Do not call dsh_wait as your first action after dsh_spawn");
    expect(directive).toContain("nothing left to hand out");
    // исходный массив систем-промпта не мутирован — дописывание через новый массив.
    expect(base).toEqual(["BASE-1", "BASE-2"]);
  });

  // П.5 (drop-llm-representative): LLM-путь выпилен целиком — директива не должна
  // тянуть ни hub (тул убран из набора), ни упоминаний представителя, кроме
  // "представитель-скрипт" (relay.ts) — он остался единственным путём доставки.
  it("директива не содержит hub и упоминаний LLM-представителя", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);
    const result = (await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    })) as { systemPrompt: string[] };
    const directive = result.systemPrompt[result.systemPrompt.length - 1] as string;

    expect(directive.toLowerCase()).not.toContain("hub");
    expect(directive.replace(/relay script/g, "")).not.toContain("representative");
  });

  it("при выключенном режиме возвращает undefined (не подменяет системный промпт)", async () => {
    const { pi, handlers } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);

    const result = await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    });

    expect(result).toBeUndefined();
  });

  // П.4: проверки НАЛИЧИЯ подстрок выше не ловят противоречие — директива могла
  // одновременно утверждать «роль @dsh наследуется исполнителем» и «роль @dsh задаёт
  // только модель представителя». Здесь проверяем смысл, а не слова: утверждения
  // разнесены по буллетам (строкам), поэтому противоречие = два несовместимых
  // утверждения в ОДНОЙ строке. Тест не хрупок к перестановке слов внутри строки.
  it("директива не противоречит коду про модель исполнителя", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);
    const result = (await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    })) as { systemPrompt: string[] };
    const directive = result.systemPrompt[result.systemPrompt.length - 1] as string;
    const lines = directive.split("\n");

    const modelLines = lines.filter((l) => /model/i.test(l));
    expect(modelLines.length).toBeGreaterThan(0);

    // (1) роль @dsh — модель ИСПОЛНИТЕЛЯ (resolveRoleModel в dsh_spawn/dsh_answer),
    // а не «только представителя»: старая формулировка связывала @dsh с представителем.
    for (const line of modelLines) {
      expect(/@dsh/.test(line) && /representative/i.test(line)).toBe(false);
    }
    expect(modelLines.some((l) => /@dsh/.test(l) && /executor/i.test(l))).toBe(true);

    // (2) при resume модель вычисляется по тому же правилу (dsh_answer зовёт
    // resolveRoleModel), а не «глобальный дефолт DSH» — в строке про resume
    // никакого дефолта быть не должно.
    const resumeLines = lines.filter((l) => /resume/i.test(l));
    expect(resumeLines.length).toBeGreaterThan(0);
    for (const line of resumeLines) {
      expect(/default/i.test(line)).toBe(false);
    }
  });

  it("директива содержит правило про dsh_kill: новый ран — новый бриф через dsh_spawn", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);
    const result = (await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    })) as { systemPrompt: string[] };
    const directive = result.systemPrompt[result.systemPrompt.length - 1] as string;
    expect(directive).toContain("You kill a run yourself via dsh_kill");
    expect(directive).toContain("a new brief via dsh_spawn");
  });

  it("директива содержит правило про timeoutMs: дефолт моста 30 минут, просрочка = error code=timeout с потерей работы", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);
    const result = (await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    })) as { systemPrompt: string[] };
    const directive = result.systemPrompt[result.systemPrompt.length - 1] as string;

    expect(directive).toContain("timeoutMs");
    expect(directive).toContain("30 minutes");
    expect(directive).toContain("error code=timeout");
    // потеря работы — ключевой мотив задавать таймаут осознанно
    expect(/loses all its work/.test(directive)).toBe(true);
  });

  // П.D: смоук показал директора, ждавшего ВНУТРИ хода (sleep-подобные тулы, опрос hub) —
  // followUp доставляется только после конца хода, так что он сам блокировал доставку.
  // Родной vibe mode даёт два равноправных пути: самодоставка после конца хода и блокирующий
  // vibe_wait с ack-дедупом — наша директива обязана описывать оба и не звать dsh_wait
  // «только диагностикой».
  it("директива: правило ожидания — завершить ход либо синхронный dsh_wait, без сна внутри хода", async () => {
    const { pi, commands, handlers } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx);
    const result = (await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: ["BASE"],
    })) as { systemPrompt: string[] };
    const directive = result.systemPrompt[result.systemPrompt.length - 1] as string;
    const lines = directive.split("\n");

    // правило существует и командное: ждать = завершить ход
    expect(/end your turn/i.test(directive)).toBe(true);
    // dsh_wait — законный синхронный путь, а не «только диагностика»
    expect(directive).not.toContain("only for diagnostics");
    // дубля после dsh_wait не будет (ack в relay) — прямым текстом, в той же строке
    expect(lines.some((l) => /dsh_wait/.test(l) && /will not bring again/i.test(l))).toBe(true);
    // sleep-подобное ожидание внутри хода упоминается только под запретом
    const sleepLines = lines.filter((l) => /sleep/i.test(l));
    expect(sleepLines.length).toBeGreaterThan(0);
    for (const line of sleepLines) {
      expect(/Do not call/i.test(line)).toBe(true);
    }
  });
});

// П.C: смоук — строка «/dvibe on» в брифе была no-op: слэш-команда недоступна модели,
// весь прогон шёл без сужения тулсета и без директивы. Тул dvibe — точка входа для модели.
describe("П.C: тул dvibe — модель включает режим сама", () => {
  it("тул зарегистрирован, описание говорит когда его звать", () => {
    const { pi, tools } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    const tool = tools.dvibe;
    expect(tool).toBeDefined();
    expect(tool.name).toBe("dvibe");
    expect(typeof tool.execute).toBe("function");
    // описание — единственное место, откуда модель узнаёт о существовании режима до включения
    expect(tool.description).toContain("director");
    expect(tool.description).toContain("action=on");
  });

  it("action=on сужает тулсет; в применённом наборе есть dvibe и все dsh_*", async () => {
    const { pi, tools, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    const res: any = await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    expect(setActiveToolsCalls).toHaveLength(1);
    const applied = setActiveToolsCalls[0];
    // без dvibe в наборе модель не смогла бы выключить режим после сужения
    expect(applied).toContain("dvibe");
    for (const t of ["dsh_spawn", "dsh_answer", "dsh_send", "dsh_wait", "dsh_list", "dsh_kill"]) {
      expect(applied).toContain(t);
    }
    // подтверждение возвращается текстом тула — модель видит, что режим включён и чем
    expect(res.content[0].text).toContain("on");
    expect(res.content[0].text).toContain("dsh_spawn");
  });

  // П.I (раунд 3, находка Codex P1): модель зовёт тул уже ПОСЛЕ before_agent_start, а
  // системный промпт хода резолвится один раз на прогон (session-tools.ts: per-turn override).
  // Значит первый ход — обычно самый важный, со спавном ранов — шёл бы без правил режима.
  // Возвращаем директиву текстом результата: это единственный канал, который модель прочитает
  // в этом же ходе. Источник один и тот же (DIRECTOR_DIRECTIVE), двух копий правил нет.
  it("action=on возвращает правила режима прямо в результате — первый ход не идёт вслепую", async () => {
    const { pi, tools, handlers } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    const res: any = await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    const text = res.content[0].text as string;
    const viaSystemPrompt: any = await handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: [],
    });
    const directive = viaSystemPrompt.systemPrompt[0] as string;
    expect(text).toContain(directive);
    // ключевое правило дефекта 2 доступно уже в этом ходе
    expect(text).toContain("end your turn");
  });

  it("action=off правил режима не возвращает", async () => {
    const { pi, tools } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    const res: any = await tools.dvibe.execute("t-2", { action: "off" }, undefined, undefined, {});
    expect(res.content[0].text).not.toContain("DVIBE mode: you are the director");
  });

  it("повторный action=on — идемпотентен и отвечает «уже включён», а не молчит", async () => {
    const { pi, tools, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    const res2: any = await tools.dvibe.execute("t-2", { action: "on" }, undefined, undefined, {});
    expect(setActiveToolsCalls).toHaveLength(1);
    expect(res2.content[0].text).toContain("already on");
  });

  it("action=off восстанавливает прежний набор", async () => {
    const { pi, tools, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    const res: any = await tools.dvibe.execute("t-2", { action: "off" }, undefined, undefined, {});
    expect(setActiveToolsCalls).toHaveLength(2);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
    expect(res.content[0].text).toContain("off");
  });

  it("тул и слэш-команда — одно состояние: on тулом, off командой", async () => {
    const { pi, tools, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await tools.dvibe.execute("t-1", { action: "on" }, undefined, undefined, {});
    await commands.dvibe.handler("off", ctx);
    expect(setActiveToolsCalls).toHaveLength(2);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
  });
});

// П.G: enabled/previousTools живут в замыкании процесса, а OMP меняет сессию БЕЗ его
// перезапуска (session_switch reason "new"|"resume"|"fork", session_branch). Без сброса:
// (а) директива инжектится в ЧУЖУЮ сессию, (б) урезанный тулсет остаётся (switchSession
// активный набор не восстанавливает, TUI-шный reconcile знает только родные режимы),
// (в) повторный вход снапшотил бы УЖЕ урезанный набор. Тот же класс дыры, что П.1
// раунда 2 у relay (resetForSessionSwitch).
describe("П.G: смена сессии внутри процесса выключает режим директора", () => {
  for (const event of ["session_switch", "session_branch"] as const) {
    it(`${event}: активный набор восстановлен, директива больше не инжектится`, async () => {
      const { pi, commands, handlers, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
      const { ctx } = makeCtx();
      registerDvibe(pi);
      await commands.dvibe.handler("on", ctx);
      expect(setActiveToolsCalls).toHaveLength(1);

      const handler = handlers[event] as ((e: unknown, c?: unknown) => unknown) | undefined;
      expect(typeof handler).toBe("function");
      await (handler as (e: unknown, c?: unknown) => unknown)({ type: event, reason: "resume" }, {});

      expect(setActiveToolsCalls).toHaveLength(2);
      expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
      // enabled=false: before_agent_start новой сессии не получает директиву
      const result = await handlers.before_agent_start({
        type: "before_agent_start",
        prompt: "p",
        systemPrompt: ["BASE"],
      });
      expect(result).toBeUndefined();
    });
  }

  it("после switch повторный вход снапшотит уже восстановленный набор, не урезанный", async () => {
    const { pi, commands, handlers, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);
    await commands.dvibe.handler("on", ctx); // (1) директорский набор
    await handlers.session_switch({ type: "session_switch", reason: "new" }, {}); // (2) восстановление
    await commands.dvibe.handler("on", ctx); // (3) директорский набор, снапшот = полный
    await commands.dvibe.handler("off", ctx); // (4) должен вернуть ПОЛНЫЙ набор

    expect(setActiveToolsCalls).toHaveLength(4);
    expect(setActiveToolsCalls[3]).toEqual(NORMAL_TOOLS); // не EXPECTED_DIRECTOR_TOOLS из ловушки снапшота
  });

  it("switch при выключенном режиме — no-op", async () => {
    const { pi, handlers, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);
    await handlers.session_switch({ type: "session_switch", reason: "resume" }, {});
    await handlers.session_branch({ type: "session_branch" }, {});
    expect(setActiveToolsCalls).toHaveLength(0);
  });
});

describe("dvibe: выход из режима", () => {
  it("восстанавливает прежний список тулов", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("on", ctx);
    await commands.dvibe.handler("off", ctx);

    expect(setActiveToolsCalls).toHaveLength(2);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
  });
});

describe("dvibe: повторный вход", () => {
  it("не затирает уже сохранённый прежний список", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("on", ctx); // первый вход: previousTools = NORMAL_TOOLS
    await commands.dvibe.handler("on", ctx); // повторный вход поверх включённого — no-op

    expect(setActiveToolsCalls).toHaveLength(1); // второй "on" не вызвал setActiveTools повторно

    await commands.dvibe.handler("off", ctx);

    expect(setActiveToolsCalls).toHaveLength(2);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS); // а не директорский набор из второго входа
  });
});

describe("dvibe: session_shutdown", () => {
  it("восстанавливает тулсет, если режим был включён (страховка без штатного restore)", async () => {
    const { pi, commands, handlers, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("on", ctx);
    expect(setActiveToolsCalls).toHaveLength(1);

    await handlers.session_shutdown({});

    expect(setActiveToolsCalls).toHaveLength(2);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
  });

  it("не трогает тулсет, если режим был выключен", async () => {
    const { pi, handlers, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    registerDvibe(pi);

    await handlers.session_shutdown({});

    expect(setActiveToolsCalls).toHaveLength(0);
  });
});

describe("dvibe: on/off идемпотентны", () => {
  it("повторный 'on' не переключает off и не дублирует setActiveTools", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("on", ctx);
    await commands.dvibe.handler("on", ctx);
    await commands.dvibe.handler("on", ctx);

    expect(setActiveToolsCalls).toHaveLength(1);
  });

  it("'off' без предварительного 'on' — no-op, не бросает", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("off", ctx);

    expect(setActiveToolsCalls).toHaveLength(0);
  });
});

describe("dvibe: тумблер без аргументов", () => {
  it("переключает on -> off -> on", async () => {
    const { pi, commands, setActiveToolsCalls } = makePi(NORMAL_TOOLS);
    const { ctx } = makeCtx();
    registerDvibe(pi);

    await commands.dvibe.handler("", ctx); // on
    await commands.dvibe.handler("", ctx); // off
    await commands.dvibe.handler("", ctx); // on again

    expect(setActiveToolsCalls).toHaveLength(3);
    expect(setActiveToolsCalls[0]).toEqual(EXPECTED_DIRECTOR_TOOLS);
    expect(setActiveToolsCalls[1]).toEqual(NORMAL_TOOLS);
    expect(setActiveToolsCalls[2]).toEqual(EXPECTED_DIRECTOR_TOOLS);
  });
});
