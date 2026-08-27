import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Stable Cordis plugin name for the resume-aware startup provider. */
export const name = "headless-resume-startup";

/** Services required before the task+resume can be resolved. */
export const inject = ["cmdlineArgs"];

/** Service provided by this plugin. */
export const HEADLESS_RESUME_STARTUP_SERVICE = "headlessStartup";

/**
 * Build the headless command that owns `--resume`. It mirrors the upstream
 * headless grammar (positional [task...]) and adds an optional resume flag so
 * bridge/CLI can do `dsh --profile headless --resume <id> "task"` or
 * `dsh --profile headless "task" --resume <id>`.
 *
 * Commander is instantiated fresh per `apply()` so tests can parse more than
 * once in one process. The task is the positional remainder; empty/whitespace
 * is a usage error and prevents service publication (same as upstream).
 */
export function headlessResumeCommand() {
  return new Command()
    .name("dsh --profile headless")
    .description("Answer one task, print the final assistant message, and exit.")
    .helpOption("-h, --help", "show this help")
    .option("--resume <id>", "resume an existing persisted session instead of creating a new one")
    .argument("[task...]", "the task text; multiple words are joined by spaces")
    .addHelpText(
      "after",
      `
Examples:
  dsh --profile headless "run the tests"                    answer one task and exit
  dsh --profile headless --resume <sessionId> "continue"    resume a persisted session
`,
    );
}

/**
 * Parse and provide the one-shot task (+ optional resume id) as an ordinary
 * Cordis service. Validates that task and resumeSessionId are coherent.
 */
export function apply(ctx) {
  const program = headlessResumeCommand();
  program.action(() => {
    const task = program.args.join(" ");
    if (task.trim() === "") {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"');
    }
    const opts = program.opts();
    const rawResume = opts.resume;
    // Normalize: undefined => undefined, whitespace-only => treat as missing (error if flag given)
    let resumeSessionId;
    if (rawResume !== undefined) {
      const trimmed = String(rawResume).trim();
      if (trimmed === "") program.error("error: --resume requires a non-empty session id");
      resumeSessionId = trimmed;
    }
    ctx.provide(HEADLESS_RESUME_STARTUP_SERVICE, {
      task,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    });
  });
  parseCmdline(ctx, program);
}
