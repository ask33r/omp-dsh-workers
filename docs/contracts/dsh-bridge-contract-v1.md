
# Contract v1: bridge-core, envelope, dsh_task (frozen interface for parallel development)

Status: FROZEN for the duration of wave 1. Changes only via the Main agent (the coordinator).

## Envelope v1 (last line of a bridge run's stdout, JSON on a single line)

```json
{"v":1,"runId":"<uuid>","sessionId":"<dsh session id|null>",
 "status":"completed|need_input|error",
 "result":"<final text, when completed>",
 "question":"<DSH's question, when need_input>",
 "error":{"code":"spawn_failed|nonzero_exit|timeout|killed|malformed_output|resume_not_found|resume_corrupt|resume_busy","message":"...","exitCode":0}}
```

- Until phase 2 the bridge assembles the envelope from dsh's exit code and stdout
  (`sessionId: null`, `need_input` does not occur).
- From phase 2 on, the DSH runner itself prints the envelope (the resume plugin); the bridge
  validates and forwards it. An invalid/missing envelope from dsh →
  the bridge prints its own with `error.code:"malformed_output"`.

## bridge-core (`tools/dsh-bridge/`) — Node/ESM, no dependencies outside the stdlib

```ts
runDsh(opts: {
  taskFile: string;            // the brief is read from a file, NEVER from an argv string
  resumeSessionId?: string;    // phase 2
  cwd: string;
  env?: Record<string,string>; // passed ON TOP of a minimal allowlist
  timeoutMs?: number;          // default 1800000
  onStdout?: (chunk: string) => void;   // streaming for dsh_task
  signal?: AbortSignal;        // cancellation → SIGTERM to the whole process group
}): Promise<Envelope>
```

- Launch: `spawn("dsh", ["--profile","headless",...], {shell:false, detached:true})`
  (detached=true for the sake of its own pgid; kill = `process.kill(-pgid, SIGTERM)`).
- Run registry: `var/runs.json` next to the bridge (atomic write via tmp+rename):
  `{runId: {pid, pgid, dshSessionId, ompAgentId?, state, startedAt}}`.
- `reapOrphans()`: on every bridge start — walk the registry, kill the groups
  of dead entries, purge the finished ones.
- CLI for debugging: `dsh-bridge run --task-file F [--resume ID] [--model SPEC]`,
  `dsh-bridge kill <runId>`, `dsh-bridge list`, `dsh-bridge reap`.
- The test matrix is defined in the planning documents of the original design
  (the "Test matrix" section); unit tests mock the dsh binary with a stub script.

## Extension tool `dsh_task` (`extensions/dsh-task/`)

- `pi.registerTool({ name: "dsh_task", ... })` [2026-08-25: aligned with code], parameters:
  `{task: string, resumeSessionId?: string, resumeFromRunId?: string, timeoutMs?: number}`
  [2026-08-25: aligned with code].
- execute: writes task to a temporary file → `runDsh` with `onUpdate` streaming
  (line-by-line buffer, throttling ≥500ms between onUpdate calls) → result =
  `{content: result|question, details: Envelope}`.
- Cancellation: forward the tool's AbortSignal into `runDsh`.
- `renderCall`: a single line "dsh ▶ <first 80 chars of the task>";
  `renderResult`: status + truncated result, the full one is in details.
- The extension does NOT touch `~/.omp`/`~/.dsh` — only code in the repo; linking into the live
  locations is done by Main.

## Resume plugin (`plugins/dsh-headless-resume/`)

- A Cordis plugin for DSH's headless profile: parsing `--resume <id>`,
  `agents.resume({resumeSessionId})` vs `agents.create()`, printing Envelope v1
  (sessionId from the runtime) as the last line of stdout.
- Resume errors → an `error` envelope with codes `resume_not_found|resume_corrupt|
  resume_busy`, exit≠0.
- Investigated separately: how cordis.patch.yml wires in a non-package plugin
  (file/link), where headless stores sessions.
- Reference for the installed DSH: `/opt/agent-tools/dsh/current/node_modules/@deepseek-ai/`
  (read-only) (installation path on the reference machine; see `DSH_MODULES` in
  `scripts/link-plugin-deps.sh`) [2026-08-25: aligned with code].

## General worker rules

- Work only in your own worktree; the live `~/.omp`, `~/.dsh`, systemd — do not touch.
- Commits: Conventional Commits, atomic, on your own branch; do not push anywhere.
- Node 22 (CodeMachine ABI); no new npm dependencies without a written
  justification recorded alongside the code.
- The result of the work is code + tests + a short report
  (what was done, what was not resolved, open questions).

## Additive extension 2026-08-25: the run's model

- `runDsh(opts: { model?: ModelSpec })` — an object `{provider, model, reasoningEffort?}`, validated before spawn, throws `ModelSpecError` on an invalid one (like `taskFile is required`). A string is not accepted.
- CLI notation `--model <provider/model[:effort]>`: `provider` — up to the first `/`, `effort ∈ {off,minimal,low,medium,high,xhigh,max}` — the suffix after the last `:`, otherwise `:` is part of the model id (`omniroute/cx/gpt-5.6-sol:high → {provider:'omniroute', model:'cx/gpt-5.6-sol', reasoningEffort:'high'}`). Errors: whitespace/control/NUL, an empty component, >200 per component, >512 in total, extra keys, an invalid effort.
- Ownership of env: the bridge always strips `DSH_MODEL_PROVIDER`, `DSH_MODEL`, `DSH_REASONING_EFFORT` from `opts.env` and sets them only from `opts.model` (`DSH_REASONING_EFFORT` — only if it is given). Without `model` these keys do not reach the child process. `DSH_RUN_ID`/`DSH_STEER_FILE` — as before (v1 sync passes `opts.env.DSH_STEER_FILE` through, async overwrites both).
- Registry entry: the field `model?: ModelSpec` — the requested model; in v1 (`run.js`) it is transient (removed after the synchronous run), in v2 it is visible to `dsh_list`.
- Envelope v1: the field `model?: ModelSpec` — additive, backward compatible; the codes `model_not_found`, `invalid_model` have been added to `ERROR_CODES`; `validateEnvelope` checks `model` by the same rules (extra keys — rejection → the bridge prints `malformed_output`). The frozen union of codes is extended, not changed: new codes are new variants, the old ones stay valid.
- Text output of `dsh_task`: extended with the same lines as in contract v2 — `error [<code>]: <message>` (fallback without a code — `error: <message>`), `model: <formatModelSpec(model)>` when `envelope.model` is present, `session: <sessionId>` when `sessionId` is non-empty, order `text → model: → session:`; the envelope does not change.
## Executor model default (extension-level, 2026-08-25)

Without `model` in `dsh_spawn`/`dsh_task`, the extension inherits the `@dsh` role's model from OMP (`modelRoles.dsh` in `config.yml`): provider/id via `ctx.models.resolve("@dsh")` (fallback `ctx.model`), effort — the suffix after the last `:` in the raw value of `modelRoles.dsh`, if it is ∈ `THINKING_LEVELS`. If the role does not resolve, the extension falls back to the current OMP session's model (`ctx.model`); only when neither resolves is `model` left out entirely, and DSH then uses its own `agent-default-model`. An explicit `model:` in the brief (the `model` parameter) takes priority. The mechanics live in the extension, not in the bridge/plugin.
