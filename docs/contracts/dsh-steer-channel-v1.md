
# Contract: steer channel into a running headless run (v1)

Complements `dsh-bridge-contract-v1.md` and `dsh-bridge-async-v2.md`. Unblocks
the `dsh_send` tool (plan, item 2.7 — done after the phase 1 smoke test).

## Why

`agent.steer(msg)` in DSH puts the message on the next **step of the current turn** and
wakes the driver (`dsh-agent-loop/lib/index.js:399`) — this is steering without losing
what has been done. The only thing missing is transport into the one-shot headless process: the runner
starts, works through the turn and exits, it has nothing to listen on.

## The channel

A file, appended to from the outside, read by the runner. One line per message (JSONL):

```json
{"v":1,"text":"write into src/, not lib/","sentAt":"2026-08-24T12:00:00.000Z"}
```

- The path is given to the runner **explicitly** — via the env `DSH_STEER_FILE`; a
  `--steer-file <path>` CLI flag is not implemented [2026-08-25: aligned with code].
  **Not given → the channel is off, the runner's behaviour does not change
  by a single byte.** This is a backward-compatibility condition, not a convenience.
- The bridge writes lines atomically via `appendFile` (O_APPEND, one `write` per
  line — writes smaller than PIPE_BUF are not torn).
- The file may be absent: this is normal, it means nobody sent anything.

## Three decisions taken before the code

### 1. Polling, not `fs.watch`

The runner polls the file every **150 ms**, reading from a saved byte
offset — the same mechanics as `readRunOutput` in v2. The reason: `fs.watch`
misses events on some filesystems and in containers, while the cost of polling here is zero.
150 ms makes sense against the neighbouring magnitudes: DSH's write-behind is 200 ms, a model
step is seconds.

### 2. What was not delivered does not vanish silently

The turn may finish before the message has been read. In that case:

- the runner does **not** try to shove it into an already-closed turn;
- the runner writes `<steerFile>.offset` next to it — the number of processed bytes;
- the caller compares the file size with the offset: a discrepancy = the message was not
  delivered, the turn ended earlier. The `dsh_send` tool must return this as an
  explicit fact ("not delivered, the run finished"), not as a success.

Envelope v1 **does not change** — it is frozen, and non-delivery is not an error of the
run.

### 3. The message format is the same as the runner's

```js
agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }))
```

Exactly as in the existing `agent.followup(...)`, without inventions.

## Lifecycle in the runner

1. A turn has been requested (`agent.followup(...)`) — **only after that** does polling
   start. Any earlier is not allowed: the message would land in the next-step of a turn that has not begun yet.
2. Every new complete line → `agent.steer(...)`. A broken line is skipped with
   an entry in stderr; an incomplete tail without `\n` is left alone until the next poll.
3. `await agent.whenIdle()` has finished → polling stops, the offset
   is written out one last time. The timer must be cleared in `finally`:
   a dangling `setInterval` will not let the process exit.

## The bridge side

```ts
sendToRun(runId: string, text: string, opts?: { registryPath?: string }): Promise<{
  delivered: boolean;   // === (status === "delivered"); kept for compatibility
  status: "delivered" | "pending" | "undeliverable";
  steerFile: string;
  pendingBytes: number; // file size minus the processed offset
  waitedMs: number;      // how long we actually waited for confirmation; 0 = the run was already not running
}>
```

Delivery is confirmed not by the fact of `appendFile`, but by the runner having ACTUALLY
read the line: it maintains `<steerFile>.offset` (see "Lifecycle in the runner" above),
and `sendToRun` itself waits AFTER the write for up to **1.2 s** (step 50 ms) until that offset
catches up with the end of what was written. Waiting for delivery is exactly the tool's job, not
something external to it. Based on the outcome of the wait — one of three statuses
(details and invariants — the `sendToRun` section in `dsh-bridge-async-v2.md`):

- `"delivered"` — the offset caught up: the runner really did read the line;
- `"pending"` — it did not catch up within the window, but the run (per a repeated state check
  after the wait) is still alive: the write reached the channel and the run was alive at that
  check, but reading is not confirmed — not a delivery guarantee, and still not a reason to
  repeat `sendToRun` or to duplicate the message by another route;
- `"undeliverable"` — the run is in a terminal state, delivery will never
  happen (including the case where the run was not `running` even BEFORE the call — the write
  into the channel was not even made, `waitedMs: 0`).

`startDsh` sets up a `steerFile` (`var/runs/<runId>.steer.jsonl`), puts the path into
the registry entry and passes it to the runner via the env `DSH_STEER_FILE`.

## The `dsh_send` tool

| Parameter | |
|---|---|
| `runId` | required |
| `text` | required, non-empty |

Return value: `{delivered, status, pendingBytes, waitedMs}`. `status:"undeliverable"`
— `isError`, with the text "NOT delivered: run ended before reading; message
lost". `status:"pending"` — NOT `isError`: the write reached the channel and the run was alive
on re-check, but there is no confirmation of reading — not a delivery guarantee. The caller must
wait for the outcome (`dsh_wait`/`dsh_list`) rather than duplicate it via another route.

## Test matrix

| Case | Expectation |
|---|---|
| channel not given | the runner behaves exactly as without the change |
| one line during a turn | `agent.steer` called exactly once, with the same text |
| several lines in a row | order preserved, no duplicates |
| incomplete line without `\n` | not processed, read after it is appended to |
| broken JSON | skipped, an entry in stderr, the remaining lines processed |
| message after `whenIdle` | `steer` NOT called, offset < file size |
| the turn finished | timer cleared, the process exits with no dangling handles |
| `sendToRun`, the runner confirmed the read within the waiting window | `status: "delivered"` |
| `sendToRun`, the run is alive, no confirmation within the waiting window | `status: "pending"` (NOT `isError`) |
| `sendToRun` on a finished run (or one that was already not `running` before the call) | `status: "undeliverable"`, `delivered: false` |
