
# Contract v2: non-blocking bridge-core API + orchestration tools

Status: FROZEN for the duration of wave 2. Complements contract v1, **does not replace it**:
`runDsh()` and the `dsh_task` tool stay as they are and keep working.

## Why

With a blocking `runDsh` the caller's turn is occupied for the whole duration of the run. In OMP there is no
interruption of a tool call in flight (`abortCurrentTool` is absent in v18.0.4):
an incoming message is applied only after the tool returns. That means steering into
the run does not get through — while criterion 3.4 of the plan requires mid-work steering to
work. Separating "start" from "wait" frees up the turn in between.

## Envelope

Unchanged — Envelope v1 (see `dsh-bridge-contract-v1.md`).

## Non-blocking API (`tools/dsh-bridge/src/index.js`)

```ts
type RunState = "running" | "completed" | "error";

type RunHandle = {
  runId: string;      // uuid
  pid: number;
  pgid: number;
  logFile: string;    // absolute path; the run's stdout+stderr
  startedAt: string;  // ISO
};

/** Starts a run and returns control IMMEDIATELY, without waiting for completion. */
startDsh(opts: {
  taskFile: string;          // as in v1: the brief only as a file
  resumeSessionId?: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;        // default 1800000; the bridge itself guards it
  registryPath?: string;
}): Promise<RunHandle>

/** A non-blocking state snapshot. Never waits. */
pollRun(runId: string, opts?: { registryPath?: string }): Promise<{
  runId: string;
  state: RunState;
  envelope: Envelope | null;   // non-null only when state !== "running"
  exitCode: number | null;
}>

/**
 * Waits for completion for no longer than waitMs. A wait timeout is NOT an error of the run:
 * it returns state:"running" and envelope:null, the run keeps living.
 */
waitRun(runId: string, opts: {
  waitMs: number;              // required; 0 = same as pollRun
  registryPath?: string;
  signal?: AbortSignal;        // cancels the WAIT, not the run
}): Promise<{ runId: string; state: RunState; envelope: Envelope | null; exitCode: number | null }>

/**
 * SIGTERM to the whole group, then (if the process has not exited within the grace period) SIGKILL.
 * Idempotent. `graceMs` is the budget for waiting for the process's REAL EXIT, not for
 * the readiness of the final envelope (writing the envelope is separate I/O that happens after the
 * exit; round 3 of the cross-review, Codex's blocker: measuring grace against
 * finalization would mean SIGKILL could fly out later than the process actually
 * exited).
 */
killRun(runId: string, opts?: {
  signal?: "SIGTERM" | "SIGKILL";
  graceMs?: number;            // default 2000
  registryPath?: string;
}): Promise<{ runId: string; killed: boolean; state: RunState }>

/** Incremental reading of the output for streaming into the UI. */
readRunOutput(runId: string, opts?: {
  offset?: number;             // byte offset, default 0
  maxBytes?: number;           // default 65536
  registryPath?: string;
}): Promise<{ chunk: string; nextOffset: number; eof: boolean }>
```

`listRuns()` and `reapOrphans()` — from v1, unchanged.

## Mandatory invariants

1. **No dangling handles in the parent.** `startDsh` spawns with `detached: true`,
   `stdio: ["ignore", fd(logFile), fd(logFile)]` and calls `child.unref()`.
   The `startDsh` promise resolves after the registry write, not after the run exits.
2. **The registry is the single source of truth.** The entry:
   `{pid, pgid, dshSessionId, state, startedAt, cwd, logFile, envelopeFile,
   exitCode}`. Written atomically (tmp+rename), as in v1.
3. **Completion survives the parent's death.** The envelope is written into
   `envelopeFile` (`var/runs/<runId>.envelope.json`) by whichever process
   observes the exit. A dead pid with a missing `envelopeFile` is **not** by
   itself proof that the observer died: the exit and the envelope write are
   distinct events, and between them the observer still reads the log and runs
   `finalizeIfAbsent`. So `pollRun` first grants the observer a bounded grace
   period (`ENVELOPE_GRACE_MS`, shared with `killRun`) — awaiting the local
   `donePromise` for a run started in this process, or re-reading
   `envelopeFile` for a run owned by another one. Only once that grace expires
   with no envelope does it synthesize an `error` with the code `killed`.
   Synthesizing earlier would not merely answer imprecisely: `finalizeIfAbsent`
   commits through `link()`, so the real envelope written a moment later loses
   on `EEXIST` and a successful run stays killed forever.
   The same grace covers the mirror image of that window. The envelope file and
   the registry entry are updated **separately** — `link()` first, `updateRun`
   (`state`, `exitCode`) after — so an envelope on disk may coexist with an
   entry still reading `running`/`exitCode: null`. That entry is a finalization
   in flight, not an outcome: `pollRun` never returns a result while the entry
   is still `running`, but waits for it within the same `ENVELOPE_GRACE_MS`
   (local `donePromise`, or re-reading the entry for a foreign run). The
   settled signal is `state !== 'running'`, not a non-null `exitCode` — a run
   killed by a signal legitimately has none. Once the grace expires the
   previous answer stands: the envelope with whatever `exitCode` is recorded.
4. **The run's timeout is guarded by the bridge, not by the caller.** `timeoutMs` expired →
   the group is killed, envelope `error/timeout`.
5. **`kill` with any signal goes only through `killPgid`/`killPid`.** A direct
   `process.kill(-pgid, …)` is forbidden: the `pgid` from the registry is data, and
   `kill(-1)` broadcasts the signal to the user's entire session (see commit
   `477df99`).
6. **`waitMs` does not affect the run.** An expired wait leaves the run alive.

## Orchestration tools (`extensions/dsh-task/`)

Registered alongside the existing `dsh_task`, not replacing it.

| Tool | Parameters | Return value |
|---|---|---|
| `dsh_spawn` | `{task, resumeSessionId?, resumeFromRunId?, timeoutMs?, label?}` [2026-08-25: aligned with code] | `{runId, pid}` + the text `started <runId>` |
| `dsh_wait` | `{runId, waitMs?}` (default 30000) | the envelope on completion; on a timeout — `{state:"running"}` and the text `still running: <runId>` [2026-08-25: aligned with code] |
| `dsh_kill` | `{runId}` | `{killed, state}` |
| `dsh_list` | `{}` | the whole registry, every run with its own `state` — including terminal ones, until `reapOrphans` has removed them |

- `dsh_spawn` writes `task` into a temporary file (like `dsh_task`) and **does not wait**.
- `dsh_wait` streams new output via `onUpdate` (line by line, throttling ≥500 ms),
  fetching it with `readRunOutput` from the saved offset. Returning because of `waitMs` is
  a normal outcome, **not** `isError`.
- Cancellation: `dsh_wait`'s AbortSignal cancels the **wait**, not the run. The
  run can only be killed with `dsh_kill` — otherwise a cancelled turn would orphan the process.
- `renderCall`/`renderResult` — in the v1 style: a single line, details in `details`.

## `dsh_send` — deferred, but genuinely implementable

The `dsh_send` tool (input into a **running** run) is not part of this wave: it needs a channel
into a live process, which the one-shot headless runner does not have. But there is no need to
give up on it — DSH can do steering natively:

```js
// dsh-agent-loop/lib/index.js:390-403
send(message, target, wakeup) { this.inbox.splice(target, Infinity, 0, [message]); if (wakeup) this.wakeDriver(...) }
followup(input) { this.send(input, "next-turn", true); }   // ← this is already used by the headless runner
steer(input)    { this.send(input, "next-step", true); }   // ← puts it into the CURRENT turn
inject(input)   { this.send(input, "next-step", false); }
```

`agent.steer(msg)` puts the message on the next **step** of the current turn and wakes
the driver — that is exactly mid-work steering, without losing what has been done.
The public `agent` object has these methods: `dsh-headless/lib/index.js:86` already
calls `agent.followup(...)`.

The only thing missing is transport into the live process. The natural place is the same
Cordis plugin that does resume (phase 2): it holds `agent` and can listen to
the run's channel (the file `var/runs/<runId>.steer.jsonl`, which the bridge appends to, or
a unix socket), passing each message into `agent.steer()`.

**Implemented.** `sendToRun(runId, text, opts)` is exactly that transport: the bridge
appends a JSONL line into `<steerFile>`, and `dsh-headless-resume`
(`plugins/dsh-headless-resume/src/steer-channel.js`) polls the file and calls
`agent.steer()`. The return value:

```ts
{
  delivered: boolean;   // === (status === "delivered"), for backward compatibility
  status: "delivered" | "pending" | "undeliverable";
  steerFile: string;
  pendingBytes: number;
  waitedMs: number;
}
```

The reader polls the channel once every 150 ms and maintains `<steerFile>.offset`; `appendFile`
may have reached the disk only AFTER the reader made its final drain
before the turn ended — in that case the line stays unread forever, even though
it is formally sitting on disk. That is why `sendToRun`, after the write, waits up to 1200 ms
(step 50 ms) until `<steerFile>.offset` catches up with the end of what was written, and based on
the outcome of that wait gives one of THREE statuses (P1 item 4, round 2 of the cross-review;
previously there was a single boolean `delivered`, and `delivered:false` conflated "the run is dead,
the message is lost forever" with "the run is alive, the channel simply has not been read yet,
it will be read later" — and those are different situations, requiring different action from the
caller):

- `"delivered"` — the offset caught up with the end of the write: the runner really did read
  the line;
- `"pending"` — it did not catch up within the window, but the run (per a repeated poll AFTER
  the wait) is still `running`: the write reached the channel and the run was alive at that
  re-check, but reading is not confirmed — this is not a delivery guarantee. Still NOT a reason
  to repeat `sendToRun` or to duplicate the message via another channel — the caller must
  wait for the outcome (`dsh_wait`) rather than duplicate a message likely to arrive anyway;
- `"undeliverable"` — the run is in a terminal state, the offset did not reach it, delivery
  will never happen. The same applies to a run that was not `running` EVEN BEFORE the call
  (the write into the channel was not even made, `waitedMs: 0`, the old early return).
  Only in this case can the message be considered lost and sent again
  by another route.

Consumers of the three-valued status: `dsh_send` in `extensions/dsh-task/index.ts`
(the response text for all three statuses) and the director's directive in
`extensions/dsh-task/dvibe.ts` (on `undeliverable` or when the run is absent from `dsh_list`,
the director may continue via `dsh_spawn` with `resumeFromRunId` — but only once the run has left
an envelope on disk; without one `dsh_spawn` throws `has no session to resume`. That covers a run
that is **still running** as well as one that is gone (killed before the envelope, crashed at
startup, already swept), so the director first tells the two apart via `dsh_list`/`dsh_wait`: a
full new brief is right only for a dead run, and for a working one it duplicates the work; on
`pending` duplicating is not allowed).

`pendingBytes` — the bytes in `<steerFile>` that `<steerFile>.offset` does not yet
cover (as of the moment of return, after the wait). `waitedMs` — how long we actually
waited; `0` means the run was already not `running` and the write into the channel was not even
made.

**`dsh_kill` + `dsh_spawn` with `resumeSessionId` is a degradation, not an
equivalent.** It loses the unfinished turn entirely. Mitigating facts (verified
in DSH's code) that make it an acceptable fallback path:

- persistence writes **write-behind in batches with a 200 ms deadline**
  (`dsh-session-persistence/lib/index.js:788`), not at the end of the run — everything except
  the last batch reaches the disk;
- a torn log is repaired as a matter of course: `commitRepair(meta, tornMarker, closers)`
  (`lib/index.js:1026`);
- the "live persistence owner" is **in-process** `Map` state (`lib/index.js:1023`),
  there is no file lock, so after the process is killed resume does not run into
  `resume_busy`.

## The run's lifetime: the owner's lease and the deadline

Added after the phase 1 smoke test — it exposed the fact that a run outlived its owner.

DSH starts with `detached: true` (its own process group), so the death of the
caller's OMP session **physically does not reach it**. And
`timeoutMs` was executed by a `setTimeout` in the memory of the process that started it and died
together with it. The result: an abandoned run kept working and burning tokens while nobody
was waiting for its result; when the whole session died — indefinitely.

That is why the lifetime is stored in the registry, not only in memory:

| Entry field | Meaning |
|---|---|
| `deadlineAt` | `startedAt + timeoutMs`. Duplicates the internal timer deliberately: the timer is local, the record outlives the process |
| `leaseUntil` | up to which moment the run is considered needed by its owner; default `DEFAULT_LEASE_MS` = 5 minutes |

**The lease is extended by acts of ownership, not of observation.** `waitRun` and
`sendToRun` extend it: whoever waits for the result or steers the run owns it.
`pollRun` and `dsh_list` do not: otherwise an outsider's browsing would resurrect the lease
of an abandoned run. On the direct path the normal owner is the script representative
(`extensions/dsh-task/relay.ts`): it calls `renewLease` every `RELAY_RENEW_MS` (60 s) for
each run it watches; `dsh_wait`/`dsh_send` are additional acts of ownership on top of that
cycle. Five minutes of silence mean there is no owner any more.

Cleanup:

- `reapExpiredRuns(registryPath, opts)` — finishes off runs whose `deadlineAt`
  has passed or whose lease nobody extended. The envelope gets **its own** reason, not
  the generic `killed`.
- `sweepRuns(registryPath, opts)` — the same plus `reapOrphans` afterwards. The order is
  mandatory: `reapOrphans` does not touch live processes, so the expired ones
  must be taken down before it.
- The absence of deadlines in an entry is **not a reason to kill**: entries in the old format and
  runs with `timeoutMs: 0` keep living.

New envelope codes (the `ERROR_CODES` set is extensible, v1 does not break):

| Code | When |
|---|---|
| `owner_gone` | the lease expired, nobody extended it — the run is abandoned |
| `deadline_exceeded` | the run outlived its own deadline |

Who sweeps:

- `extensions/dsh-task/` — at load time (picking up the survivors of the previous OMP
  session) and every 30 s thereafter; the timer is `unref`'d, a cleanup failure does not bring the session down.
- `dsh-bridge reap` — the same pass from the outside, when OMP is not running.

The guarantee is deliberately **not instantaneous**: between the owner's death and the cleanup
up to `leaseMs` + the sweeping interval elapses. That is the price of forgoing a watchdog
process for every run. What is guaranteed is that an abandoned run does not live forever and does not
depend on whether the caller set `timeoutMs`.

### Decision: the reaper does NOT check ownership — this is deliberate, not a hole

Twice someone has read `reapExpiredRuns` as a security hole — "it kills another session's run without
verifying ownership" — and twice an ownership check was attempted. Both attempts were wrong; here is
why the missing check is the correct design and must not be "fixed":

- The lease is renewed by acts of a **live** owner: the script representative calls `renewLease`
  every `RELAY_RENEW_MS` (60 s) for each run it watches, plus `waitRun`/`sendToRun` renew on top.
  If the lease nevertheless expired, there is **no one alive left to renew it** — the owner of an
  expired lease is dead by definition. There is no live owner whose interests an ownership check
  could protect.
- For the reaper specifically, "own run" versus "foreign run" carries no information. Own runs are
  already killed deterministically on `session_shutdown`; a watchdog that reaped only its own runs
  would therefore reap nothing that needed reaping, while abandoned foreign runs — the entire reason
  the reaper exists — would stay alive forever, burning tokens. An ownership check in the reaper
  doesn't narrow its authority; it deletes its purpose.
- The same absence of a check means the opposite thing in `dsh_kill`: there the caller acts **on
  demand** against a run that is usually still `running`, possibly someone else's work in flight —
  which is why ownership marking was added there (`details.ownRun`). Expiry is what separates the two:
  the reaper acts on registry-proven abandonment, `dsh_kill` on a human/tool decision, and only the
  latter needs the ownership question answered.

## `need_input` and the question protocol

DSH itself does not know the `need_input` status. A model that needs a human's answer
normally ends the turn as `completed` with a question as the text; the internal `blocked`
is about something else (a step rejected by a gate, `dsh-agent-loop/lib/index.js:539`).

That is why the question is tagged with a marker. The bridge appends the protocol to the task
(`withAskProtocol`, `tools/dsh-bridge/src/task-protocol.js`), the phase 2 runner
recognizes the marker `NEED_INPUT:` at the start of a line and prints an envelope with
`status: "need_input"` and the field `question`.

**The protocol is off by default.** Verbatim delivery of the brief is an invariant
of contract v1, and the bridge core has no right to break it on its own; it is enabled by the tool layer
(`dsh_task`, `dsh_spawn` pass `askProtocol: true`), which knows that behind
the run stands a caller capable of handling a question. A direct call into
bridge-core stays verbatim.

Why not a persona: the persona of the headless profile is shared with web and tui — the home layer
`~/.dsh/cordis.patch.yml` is applied after the profile one and overrides it, while a
`--patch` overlay would have to be duplicated in full and would drift on every
edit of the persona.

`need_input` is a **separate state of the run**, not `completed`:

| `envelope.status` | `state` |
|---|---|
| `completed` | `completed` |
| `need_input` | `need_input` |
| `error` | `error` |

Otherwise the caller would take the text of the question for a finished result. For everyone who checks `state !== "running"`,
`need_input` remains terminal — waiting, steering and cleanup behave
as before.

## Test matrix v2 (run before declaring readiness)

| Case | Expectation |
|---|---|
| `startDsh` returns before the run finishes | the promise resolves while the pid is alive |
| `pollRun` during a run | `state:"running"`, `envelope:null` |
| `waitRun` with a short `waitMs` on a long run | `state:"running"`, the run is alive after the return |
| `waitRun` waits for completion | a correct envelope, `exitCode` |
| `readRunOutput` with an offset | bytes without losses or duplicates across sequential reads |
| `killRun` during a run | the group is dead; the entry moves into a terminal `state` and holds `exitCode` (it is removed by `reapOrphans`, not by kill itself — otherwise the outcome after kill could not be read) |
| the run outlived the death of the observer | `pollRun` synthesizes `error/killed`, does not hang |
| `dsh_wait` timeout | not `isError`, the run keeps living, a repeated `dsh_wait` waits it out |
| AbortSignal on `dsh_wait` | the wait is interrupted, the run is NOT killed |
| the run's `timeoutMs` expired | envelope `error/timeout`, the group is killed |

## The executor's model (2026-08-25)

The parameter `startDsh({ model?: ModelSpec })` / `runDsh({ model })` — an object only, a string is not accepted (throws `ModelSpecError` before spawn, like `taskFile is required`). `ModelSpec = {provider, model, reasoningEffort?}`; the parser `parseModelSpec`/`formatModelSpec` in `tools/dsh-bridge/src/model-spec.js` is the only one on the CLI/extension ↔ bridge boundary.

The env channel: `DSH_MODEL_PROVIDER`, `DSH_MODEL`, `DSH_REASONING_EFFORT` — always stripped from `opts.env` and set only from the validated `opts.model` (`DSH_REASONING_EFFORT` — only if it is given). Without `model` none of the keys reaches the child process. `DSH_RUN_ID`/`DSH_STEER_FILE` — as before (v1 sync passes `opts.env.DSH_STEER_FILE` through, async overwrites both). The guarantee "without the parameter — routing and env are unchanged"; the envelope has been extended with a backward-compatible `model` field.

Codes (the table in §3.3 of the plan): an explicit list of `LlmError` metadata at preflight → `invalid_model` (`INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT`, `INVALID_MODEL_REASONING`, `INVALID_MODEL_MAX_TOKENS`); `NO_ADAPTER`/`UNKNOWN_MODEL` → `model_not_found`; an effort on a non-reasoning model or ∉ `info.reasoning.efforts[].id` → `invalid_model`; a provider without a model and vice versa → `invalid_model`; an unknown `LlmError` and a non-`LlmError` → `nonzero_exit`.

`Envelope.model` is the last prepared conversation-request configuration of the current run, taken from the `request/header` event (`session.append("request/header",{header:{config,…}})`), written by the runner; it is not proof of sending (the header comes before `preparedCall.stream`; an abort in between leaves the header without a request; direct compaction calls to `ctx.llm.stream()` are not covered). Compaction calls are not covered. Best effort inside `run()`, `fail()` does not carry the field. On resume the header of the previous run is cut off (`seq < firstSeq`). `validateEnvelope` checks `model` by the same rules (extra keys — rejection → `malformed_output`).

Non-inheritance on resume: without a run `model` the resumed session goes to the current global default; with `model` — to the new override. Exception: until the first new `request/header`, pre-step compaction reads `session.requestHeader()` of the previous run and `summarizeWithLlm` prefers that header over the new `agent.options` — the first compaction check on resume goes on the previous run's model.

The TOCTOU boundary: a hot reload of `settings.yaml` between preflight and the first request; within a run env is fixed, the catalog is not. Catalog strictness is adapter-dependent: pi-ai is strict (`UNKNOWN_MODEL`), `deepseek-official` lets an unknown id through (routing there is permissive too — there is no desync). `dsh_list` shows the requested `model` from the registry.

### Text output of `dsh_task`/`dsh_wait`

The director sees only `content` (`details` are not available), so what is checkable is duplicated as lines of text — verified against `extensions/dsh-task/index.ts` (`modelLine`/`sessionLine`/`errorPrefix`):

- an error envelope (`status: "error"`) → the first line `error [<code>]: <message>` (the message fallback is `dsh_task failed` / `dsh run failed`; without a code — `error: <message>`);
- when `envelope.model` is present → the line `model: <formatModelSpec(model)>`;
- when `envelope.sessionId` is non-empty (`typeof === "string" && length > 0`) → the line `session: <sessionId>`;
- line order: the result/question/error text → `model:` → `session:` (for preflight errors `sessionId = null` → there is no `session:` line).
## Session shutdown kills own runs (extension-level, 2026-08-25)

A regular OMP session exit (`session_shutdown`, `extensions/dsh-task/index.ts`) kills runs **started by this process** (`tools/dsh-bridge/src/async-run.js:ownRunIds()` — only `activeRuns` with `!flags.closed && !flags.spawnError`). Other sessions' runs are visible only through the registry and are not touched — they are left to the watchdog (`reapExpiredRuns`/`sweepRuns`). No confirmation is requested. The registry and `var/runs/<runId>.envelope.json` are **not cleaned up** — the next session's `dsh_list` needs them for diagnostics. An emergency exit (a process crash, without `session_shutdown`) is still left to the watchdog, as before: within `DEFAULT_LEASE_MS` + the run-sweep interval, `sweepRuns` will finish it off.

Implementation: `pi.on("session_shutdown", ...)` next to `startOrphanWatchdog()` in `dshTaskExtension`; if `typeof ownRunIds !== "function"` (a mocked bridge in tests) — the hook is not registered. `Promise.allSettled(ids.map((id) => killRun(id)))` under an overall cap of `SESSION_SHUTDOWN_KILL_CAP_MS=5000ms` (`Promise.race` against an `unref`'d timer), all errors are swallowed. `killRun` sends `SIGTERM` synchronously before the first `await` (see `async-run.js:killRun`, ~line 668), so the signal goes out even if OMP does not wait for the hook (`SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS=2000` in `runner.d.ts`); escalation to `SIGKILL` after ~2s is best effort.

`dsh_kill` (extension-level) deliberately does **not** check ownership, unlike `session_shutdown`: it kills any registry run by id, including runs this session did not start, and instead reports what it knows in its result — the result text carries a mark (`(own)` / `(not this session's active run)`) and `details` a boolean `ownRun`. Ownership is determined via `ownRunIds()`, guarded by `typeof ownRunIds === "function"` (a mocked bridge may lack it) — without the function the mark is omitted and `details.ownRun` is absent. Note that `ownRunIds()` lists only this process's **live** starts (`!closed && !spawnError`), so absence from it does not prove the run is another session's: one of this session's own finished runs looks exactly the same from here, which is why the negative mark states that rather than claiming the run is foreign. Killing another session's live run destroys its work in flight; `dsh_list` shows other sessions' runs too, so the caller must verify ownership before killing.

## Script representative (extension-level, 2026-08-25)

A DSH worker's question and its result reach the director **verbatim** as native OMP agent messages through the script representative (`extensions/dsh-task/relay.ts`), without an LLM intermediary.

Mechanics: `pi.sendMessage({ customType: "irc:incoming", content: text, display: true, details: { id: runId, from: label, message: text }, attribution: "agent" }, { triggerTurn: true, deliverAs: "followUp" })` — the native `custom_message` shape with `customType: "irc:incoming"` (rendered by the built-in `buildIrcMessageCard` from `src/session/irc-bridge.ts:119`, `src/modes/utils/transcript-render-helpers.ts:110-133`). `deliverAs: "followUp"` does not interrupt the current turn (steer — does interrupt, forbidden); `triggerTurn: true` wakes an idle session. `"irc:incoming"` is an internal OMP string literal: a guard test in `relay.test.ts` checks that it is present in the source.

Events: `→ need_input` → `⟨label⟩ asks: <question>\n(reply: dsh_answer runId=<runId>)` (the question comes from `envelope.question`, see `extractQuestion`); `→ completed` → `⟨label⟩ finished: <result>` + the `model:`/`session:` lines (reuses `modelLine`/`sessionLine` from `index.ts`); `→ error|killed|timeout` → `⟨label⟩ failed: error [<code>]: <message>` / `⟨label⟩ killed`. The announcement is tagged with a timestamp (`announcedAt`), not a binary fact. `need_input` is repeated verbatim every ≥120s (`NEED_INPUT_REANNOUNCE_MS`) until the question is closed: closing means either a successful `dsh_answer` for this runId (`unwatchRun`) or the run transitioning into a terminal state (the announcement keys differ, so a `dsh_kill` after the question is announced as "killed"); an `ack` from `dsh_wait` only postpones the reminder. A terminal event, once announced, keeps the run under observation and is repeated verbatim every ≥120s (`TERMINAL_REANNOUNCE_MS`) until a **delivery receipt** arrives — a `message_start` event whose payload matches what was sent (`details.id` = runId and `details.message` = the announcement text); at that point the run is dropped from observation without repeating. The receipt confirms that the followUp landed in the turn's context: the agent loop emits incoming messages immediately before calling the model (`agent-loop.ts: emitInputMessages`). A `need_input` with confirmed delivery is no longer reminded about (the question is already in context), but stays under observation until `dsh_answer`. The number of sends for one event is capped at `MAX_ANNOUNCE_ATTEMPTS = 3` — a safeguard for a host that does not emit `message_start` at all.

Boundary of the guarantee: `ExtensionAPI.sendMessage` is declared as `void` (`extensions/types.ts:1426`), and internally the host merely fires `session.sendCustomMessage(...)` with its own `.catch` into its own reporter (`modes/runtime-init.ts:59-71`). No receipt of the write into the transcript is returned to the extension. So "sent" for the relay means **queued without a synchronous channel failure**, not confirmed delivery. A live smoke test on 2026-08-26 showed the cost: an Esc-abort of the director's turn loses the followUp queue irrecoverably (OMP deliberately does not resume a turn from the queue — `#drainStrandedQueuedMessages`), so the rule "sent means delivered" was replaced with deterministic closure with retries from the envelope (see above). This is our equivalent of OMP's native guarantee — an owner-routed delivery sink + the session's yield queue (entries live until successful injection, `requestIdleFlush` on every turn settle, including an Esc-abort) — which ExtensionAPI does not have; retrying from the envelope is even more robust — it survives a process restart. The sign of delivery is not "a turn started" but a payload match in `message_start` (see above). The `before_agent_start` counter heuristic held through round 3 of the cross-review and was wrong in both directions: a human turn during a lost queue counted as delivery, while a followUp merged into an **already running** agent loop (`agent-loop.ts`: `getFollowUpMessages` → `pendingMessages` → `continue`) does not pass through `before_agent_start` at all — the already-read result kept repeating every 120s until the director stopped. Dedup for the synchronous-read path: after returning the envelope, `dsh_wait` calls `acknowledgeRun` (a mirror of native vibe mode's `acknowledgeDeliveries`) — a terminal run is dropped from observation without an announcement, `need_input` stays, but the reminder is deferred by a full interval from the ack.

A session switch within a live process (`session_switch`/`session_branch`, `extensions/dsh-task/index.ts` → `resetForSessionSwitch()` in `relay.ts`) resets all relay state: observation, both label maps, the timer. Otherwise an event from the OLD session's run would end up as a followUp in the NEW session's transcript. The reset is hooked to the AFTER-event, not to `session_before_switch`: the latter is cancelable (`SessionBeforeSwitchResult.cancel`). Runs are **not killed** in this case (unlike `session_shutdown`): the process is alive, the runs stay in the registry and remain accessible through `dsh_list`.

Ownership: only runs started by **this** session (`watchRun` from `dsh_spawn`/`dsh_answer`) produce messages; other runs from the registry do not. The pump is a once-per-1s timer (modeled on the watchdog in `index.ts`: `unref`, a guard against a double start, stops when `watched` is empty), calling `pollRun(runId, {})` on each tick. Pump errors are swallowed.

`dsh_answer` (`extensions/dsh-task/index.ts`): `{ runId?, label?, answer }` — at least one of runId/label; both together is valid too: runId selects the target run, label sets the label of the new run (per the smoke test: the relay message hints the runId, the directive teaches the label — the model predictably passes both). `startDsh({ task: answer, resumeFromRunId, cwd, label, model: resolveRoleModel(ctx), askProtocol: true })`; on success → `watchRun(newRunId, label)` + `unwatchRun(oldRunId)` (deterministic closure of need_input), the reply is `answered <old> -> <new>`. FollowUp-only, steer is forbidden. Both branches take the label for the new run first from the relay (`resolveLabel` by label, `resolveLabelForRun` by runId — both maps survive being dropped from observation), and only then fall back to `listRuns`: by the time the answer arrives the entry has usually already been swept out by `reapOrphans` (≤30s), and without a label the ⟨label⟩ chain breaks down to `shortId`. The registry is irreplaceable for a run that was not set up through the relay (a different session, the CLI bridge).

## Executor model default (extension-level, 2026-08-25)

Without `model` in `dsh_spawn`/`dsh_task`, the extension inherits the `@dsh` role's model from OMP (`modelRoles.dsh` in `config.yml`): provider/id via `ctx.models.resolve("@dsh")` (fallback `ctx.model` — the current session's model), effort is the suffix after the last `:` in the raw value of `modelRoles.dsh`, if it is ∈ `THINKING_LEVELS`. If neither the role nor `ctx.model` resolves, `model` is not passed at all (DSH falls back to its own `agent-default-model`). An explicit `model:` in the brief (the `model` parameter) takes priority. The mechanism lives in the extension, not in the bridge/plugin.

The rule is the same for a new run and for resume: the model is not sticky and is computed fresh on every call, so "without `model` on resume — the global default" holds only at the bridge/DSH level (see *The executor's model* above), but not at the extension level: `resolveRoleModel(ctx)` will substitute the `@dsh` role. `dsh_answer` has no `model` parameter — the continuation always runs on the role's model.
