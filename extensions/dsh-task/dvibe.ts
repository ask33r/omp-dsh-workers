import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// --- Режим директора (`/dvibe` — для человека, тул `dvibe` — для модели) ---
//
// Смысл: главная сессия перестаёт быть исполнителем и становится раздающей.
// Работу делают внешние DSH-процессы, которых директор спавнит сам тулом
// `dsh_spawn`; их события (вопросы, результаты) приходят в чат через
// представитель-скрипт (extensions/dsh-task/relay.ts). Сам директор файлы не
// редактирует и команды не запускает — поэтому в режиме активен узкий
// тулсет, а не полный.

/**
 * Обязательный тулсет режима директора. Имена сверены с исходниками OMP v18:
 * - "read", "todo" — встроенные (builtin-names.ts);
 * - "dsh_send"/"dsh_wait" — не для запуска ранов (это dsh_spawn), а для
 *   детерминированного steering в уже живой ран (по runId, найденному в
 *   dsh_list по метке — label из tools/dsh-bridge) и для детерминированного
 *   чтения его результата.
 * - "dsh_list" — свой тул диагностики ранов (см. index.ts) и теперь ещё
 *   источник runId по метке для dsh_send/dsh_wait.
 * - "dsh_kill" — директорская отмена своего рана (runId из dsh_list по
 *   метке).
 * - "dsh_spawn"/"dsh_answer" — путь директора: брифы отдаёт сам через
 *   dsh_spawn (бриф = дословный текст задачи), вопросы воркеров приходят в
 *   чат как сообщения ⟨метка⟩ через представитель-скрипт (relay.ts,
 *   followUp-only, события irc:incoming), отвечает через dsh_answer;
 *   результат приходит сам тем же каналом, синхронная альтернатива —
 *   dsh_wait (полученный через него envelope ack'ается в relay и повторно не
 *   приносится). Раньше dsh_spawn был намеренно закрыт у директора, чтобы
 *   раны заводили только представители; теперь их заменил
 *   представитель-скрипт (relay.ts), и прямой спавн директора разрешён.
 * - "dvibe" — сам тул переключения режима: setActiveTools заменяет активный
 *   набор целиком, и без dvibe в наборе модель, включив режим, не смогла бы
 *   его выключить.
 */
const REQUIRED_DIRECTOR_TOOLS = [
  "read",
  "todo",
  "dsh_spawn",
  "dsh_answer",
  "dsh_send",
  "dsh_wait",
  "dsh_list",
  "dsh_kill",
  "dvibe",
] as const;

const DIRECTOR_DIRECTIVE = `DVIBE mode: you are the director. External DSH workers do the work; edit and run nothing yourself — your job is to hand out tasks, keep watch, and synthesize.

Rules:
- Hand out briefs yourself via dsh_spawn (a brief is the verbatim task text; label goes in the label parameter, model in the model parameter). Worker questions arrive in chat as ⟨label⟩ messages through the relay script (relay.ts, followUp-only) — reply via dsh_answer; the result arrives on its own over the same channel.
- Know two ways to wait. Primary: once you finish handing out, end your turn immediately; relay events (questions and results ⟨label⟩) are delivered only AFTER the turn ends and will wake you by themselves — waiting inside a turn blocks their delivery. Synchronous: dsh_wait with a specific runId — only when your next step is blocked on the result of THAT run and there is nothing left to hand out; what you receive via dsh_wait relay will not bring again. Do not call dsh_wait as your first action after dsh_spawn: while you hang waiting, events of ALL other runs go undelivered, and parallel work turns sequential. Do not call sleep-like tools.
- A question from a worker (need_input) — answer it substantively and fast; the worker continues that same DSH session on its own.
- Do NOT specify the executor model (the DSH process) without a reason: without the model parameter the executor inherits the model of the @dsh role from OMP (modelRoles.dsh in config.yml, together with its thinking level); if the @dsh role does not resolve — your current session's model is used, and only if even that is missing — DSH's own default. A different model — only if the task requires it or the user named one; then the model parameter in the <provider>/<model>[:<effort>] notation, e.g. myprovider/my-model:high. model_not_found/invalid_model errors — fix the spec, do not swap the model silently.
- The model is not sticky: on resumeFromRunId it is computed anew by the same rule, not inherited from the previous run. dsh_answer has no model parameter at all — continuation always runs on the role's model; if you need another, start a run via dsh_spawn with resumeFromRunId and an explicit model.
- Give each task a short Latin label as the label parameter of the dsh_spawn tool. To clarify something to a RUNNING worker: find the run in dsh_list by label, then dsh_send with its runId. delivered:true — already in the run, do not duplicate. pending — written to the channel, the run was alive; this is NOT a delivery guarantee (durable is not promised, only delivered confirms) — do not duplicate, wait for the outcome. Order is preserved across consecutive successful writes, but the channel is read at step/tool boundaries — a stream of clarifications will arrive batched and delayed, do not send several at once. No run with the label in dsh_list — not proof of completion (reapOrphans may have swept away a live run's record): first dsh_wait on the known runId for the envelope, then decide. status:undeliverable — the run finished, the message is lost: resume is possible only if the run has a session — dsh_spawn with resumeFromRunId. The "has no session to resume" error — no envelope yet: either the run is ALIVE and simply has not written it, or dead (killed before the envelope, crashed at startup, swept). First tell the cases apart: dsh_list by label and dsh_wait by runId. Alive — wait it out; a new brief here would double the work. Dead — a new FULL brief via dsh_spawn WITHOUT resume; the prior work will not continue.
- You kill a run yourself via dsh_kill (runId — from dsh_list by label) when it is no longer needed or has clearly gone off the rails: doing the wrong thing, silent longer than reasonable. Do not kill "just in case". Note: dsh_list shows other sessions' runs too, and dsh_kill kills ANY registry run by id — killing another session's run destroys its work in flight, so before kill make sure the run is yours. Need a new run — a new brief via dsh_spawn.
- For implementation tasks set the timeoutMs parameter according to the size of the work. The bridge default is 30 minutes; a run hitting that default dies with error code=timeout and loses all its work.
- Verify results by reading files, not by the worker's retelling. dsh_list is for diagnostics and finding runId by label, not a tool for managing runs.
- Synthesize the outcome yourself: who produced what, what did not add up, what remains.`;

export function registerDvibe(pi: ExtensionAPI): void {
  // Состояние живёт в замыкании этого вызова, а не на верхнем уровне файла:
  // registerDvibe вызывается ровно один раз за сессию (dshTaskExtension), так
  // что замыкание и есть её "модульная" память на весь срок жизни сессии —
  // и при этом каждый тест получает чистое состояние на свой собственный вызов.
  let enabled = false;
  let previousTools: string[] | null = null;

  // Итог переключения отдаём данными, а не побочным ctx.ui.notify: у слэш-команды и у тула
  // разные каналы ответа (тост человеку vs текст результата модели), а состояние — одно.
  type SwitchOutcome = { changed: boolean; message: string; warnings: string[] };

  // Общий restore для exit()/session_shutdown/session_switch/session_branch — одна копия
  // (П.G): у setActiveTools нет штатного снапшота-восстановления, это наша забота.
  async function restorePreviousTools(): Promise<void> {
    if (!enabled) return;
    await pi.setActiveTools(previousTools ?? []);
    enabled = false;
    previousTools = null;
  }

  async function enter(): Promise<SwitchOutcome> {
    // Повторный вход поверх уже включённого режима не должен перезаписать
    // previousTools директорским набором — иначе выход вернёт директорские
    // тулы вместо тех, что были активны до самого первого входа. И отвечает
    // внятно «уже включён»: молчание тула модель прочитала бы как сбой.
    if (enabled) {
      return { changed: false, message: "DVIBE: director mode is already on.", warnings: [] };
    }

    const previous = pi.getActiveTools();
    previousTools = previous;
    const previousSet = new Set(previous);
    const kept = REQUIRED_DIRECTOR_TOOLS.filter((name) => previousSet.has(name));
    const missing = REQUIRED_DIRECTOR_TOOLS.filter((name) => !previousSet.has(name));
    const desired = [...kept, ...missing];

    const warnings: string[] = [];
    let applied: string[] = desired;
    try {
      // OMP (session/session-tools.ts: setActiveToolsByName → #applyActiveToolsByName)
      // молча отфильтровывает имена, которых нет в реестре сессии, а не бросает —
      // поэтому обязательные тулы безопасно добавлять, даже если их не было в
      // прежнем активном наборе (см. отчёт задачи по dvibe).
      await pi.setActiveTools(desired);
    } catch {
      // Резерв на случай, если это поведение когда-нибудь изменится: не отдаём
      // директору неизвестно какой тулсет — откатываемся к пересечению с прежним.
      applied = kept;
      await pi.setActiveTools(kept);
      warnings.push(
        `DVIBE: setActiveTools rejected some required tools (${missing.join(", ")}); mode narrowed to the intersection with the previous set.`,
      );
    }

    enabled = true;
    return { changed: true, message: `DVIBE: director mode on. Active tools: ${applied.join(", ")}`, warnings };
  }

  async function exit(): Promise<SwitchOutcome> {
    if (!enabled) {
      return { changed: false, message: "DVIBE: director mode is already off.", warnings: [] };
    }
    await restorePreviousTools();
    return { changed: true, message: "DVIBE: director mode off, previous tool set restored.", warnings: [] };
  }

  pi.registerCommand("dvibe", {
    description: "Toggle the DVIBE director mode: hand out work to external DSH workers via dsh_spawn",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const outcome =
        arg === "on" ? await enter() : arg === "off" ? await exit() : enabled ? await exit() : await enter();
      for (const w of outcome.warnings) ctx.ui.notify(w, "warning");
      // Идемпотентный повтор (`/dvibe on` при включённом) для человека молчит, как и раньше:
      // лишний тост в TUI не нужен; модель тот же ответ получает текстом тула dvibe.
      if (outcome.changed) ctx.ui.notify(outcome.message);
    },
  });

  // П.C (смоук 2026-08-26): строка «/dvibe on» в брифе — no-op, слэш-команда модели
  // недоступна, и весь прогон шёл без сужения тулсета и без директивы. Тул — точка входа
  // модели; его description — единственное место, откуда модель узнаёт о режиме до
  // включения. Подтверждение возвращаем текстом результата (а не ctx.ui.notify): модель
  // видит «режим включён» и итоговый набор тулов.
  pi.registerTool({
    name: "dvibe",
    label: "DVIBE director mode",
    description:
      "Enables/disables the DVIBE director mode: a narrow toolset (dsh_* + read/todo) and the director directive in the system prompt. Call with action=on as your FIRST action if you are asked to work as a director of DSH workers; action=off restores the previous tool set.",
    parameters: pi.zod.object({
      action: pi.zod.enum(["on", "off"]).describe("on — enable director mode, off — disable it"),
    }),
    async execute(_toolCallId: string, params: { action: "on" | "off" }) {
      const outcome = params.action === "on" ? await enter() : await exit();
      const parts = [outcome.message, ...outcome.warnings];
      // П.I (раунд 3): модель зовёт тул уже ПОСЛЕ before_agent_start, а системный промпт хода
      // резолвится один раз на прогон (OMP session-tools.ts, per-turn override) — включение
      // тулом меняет тулсет немедленно, а директиву дало бы только со следующего хода. Первый
      // ход директора — обычно как раз раздача ранов, и он шёл бы без правила «не жди внутри
      // хода», ради которого правило и появилось. Отдаём правила результатом тула: это
      // единственный канал, который модель прочитает в этом же ходе. Источник тот же самый —
      // двух копий правил не заводим.
      if (params.action === "on" && enabled) parts.push("", DIRECTOR_DIRECTIVE);
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: { enabled },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return undefined;
    // ПОЛНАЯ замена системного промпта хода — чтобы дописать, а не затереть,
    // обязательно разворачиваем event.systemPrompt перед добавлением директивы.
    return { systemPrompt: [...event.systemPrompt, DIRECTOR_DIRECTIVE] };
  });

  pi.on("session_shutdown", async () => {
    // У setActiveTools нет штатного restore (плоская замена без снапшота), а
    // сессия может закрыться прямо в режиме директора — без этой страховки
    // следующая сессия того же долгоживущего процесса (SDK/ACP) унаследует
    // урезанный тулсет вместо того, что было до входа в режим.
    await restorePreviousTools();
  });

  // П.G: смена сессии БЕЗ перезапуска процесса (session_switch reason "new"|"resume"|"fork",
  // session_branch) — enabled/previousTools живут в замыкании процесса и пережили бы её:
  // (а) директива инжектилась бы в ЧУЖУЮ сессию, (б) урезанный тулсет оставался бы активным
  // (switchSession в agent-session.ts активный набор сам не восстанавливает, а TUI-шный
  // #reconcileModeFromSession восстанавливает только РОДНЫЕ режимы vibe/plan/goal из персиста
  // mode_change и про dvibe не знает), (в) повторный вход в новой сессии снапшотил бы УЖЕ
  // урезанный набор — ловушка, которую родной код обходит явно (interactive-mode.ts:
  // «re-snapshotting it here would make the snapshot useless»).
  //
  // Выходим из режима, а не переносим его: целевая сессия режим не просила, а родной паттерн —
  // восстановление режима из персиста ЦЕЛЕВОЙ сессии; у dvibe персиста нет (персист через
  // ctx.sessionManager.getEntries + pi.appendEntry — осознанно отложенная отдельная задача),
  // безопасный дефолт — выйти и вернуть полный набор. Вешаемся на ПОСЛЕ-события, не на
  // session_before_switch: before-события отменяемы (SessionBeforeSwitchResult.cancel) — тот
  // же выбор, что у relay-сброса (resetForSessionSwitch в index.ts).
  pi.on("session_switch", async () => {
    await restorePreviousTools();
  });
  pi.on("session_branch", async () => {
    await restorePreviousTools();
  });
}
