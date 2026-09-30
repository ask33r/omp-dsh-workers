# DSH — agent instructions

An oh-my-pi (OMP) extension: an OMP session acts as *director* and spawns
persistent DeepSeek-Harness workers (`dsh --profile headless`) via `dsh_spawn` /
`dsh_wait`, relaying their results back as native chat messages. `README.md`
carries the full tool table, error codes and install steps.

## Stack

TypeScript on Bun for `extensions/`, dependency-free plain Node ≥22 ESM for
`tools/dsh-bridge/`, Biome 2.5.10 for lint and format. Bun is the package
manager — there is no npm/yarn/pnpm lockfile.

## Commands

- `bun run check` — Biome lint + format
- `bun run typecheck` — `tsc --noEmit`
- `bun run test` — unit + integration + bridge suites
- `.github/workflows/test.yml` is the ground truth for CI order and env

## Invariants

- **Never run a bare `bun test` from the repo root.** Bun's `mock.module()` is
  process-global, so `extensions/dsh-task` mocks leak into the bridge's Node
  tests and turn `kill(pid)` into `kill(-1)` — inside a container that kills the
  whole session. The reason is recorded in `bunfig.toml`, and
  `tools/dsh-bridge/test/node-only.js` is the second guard. Use the `test:*`
  scripts.
- Run tests with an isolated `$HOME`. Three tests once passed only by accident,
  reading the developer's real `~/.omp` and `~/.dsh`.
- `tools/dsh-bridge/` stays dependency-free and build-step-free. Do not add
  dependencies, a bundler or TypeScript there.
- The repository is the source of truth: install scripts only symlink live
  directories back into it, and abort rather than overwrite a real file.
- The language split is deliberate — everything a human or a model reads is
  English, in-code comments and test names are Russian. Do not "fix" it.
- No concrete model id is ever hardcoded — not as a default, not as a fallback.
  The executor model is resolved at runtime: the `model` argument of
  `dsh_spawn`/`dsh_task` → the `@dsh` role (`modelRoles.dsh`) → the session's
  `ctx.model` → nothing passed, so DSH falls back to its own
  `agent-default-model` (`extensions/dsh-task/role-model.ts`;
  `tools/dsh-bridge/src/run.js` owns the three `DSH_MODEL*` env keys and clears
  them on every run). Real ids belong in local configs only — outside the repo.
  Inside it they may appear as test fixtures and as `<provider>/<model>[:<effort>]`
  notation examples in docs, nowhere else.

## Layout

`extensions/dsh-task` (OMP extension), `tools/dsh-bridge` (bridge core),
`plugins/dsh-headless-resume` (Cordis plugin), `scripts/` (install), `docs/`
(contracts, diagrams), `.github/workflows/`.

## State and memory

`CONTEXT.md` is a generated Engram digest: local-only (gitignored), rebuilt by
`/mb sync`, never hand-edited. Durable memory lives in Engram, project `dsh`.
Verify what it claims against the files before acting on it — it lags behind
`main` and can describe unmerged branches.
