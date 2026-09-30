# DSH update checklist (worker side)

How a new DSH release is built and published depends on the toolchain that hosts it
and is out of scope here. This file covers only what must be checked **on the DSH
workers' side** after a new release is activated.

## Why this is needed

Our resume patch lives in the user layer
(`~/.dsh/profiles/headless/cordis.patch.yml` + plugin code in this repo) and
applies to any release automatically — **no need to re-patch on update**.
But a new release can break it semantically:

- an entry id that `- insert` attaches to gets renamed → the patch silently stops applying;
- drift in the `dsh-agent` API (`agents.resume`/`agents.create`) or `dsh-session-persistence`;
- the headless runner's stdout format changes → the envelope breaks.
- since 0.2 dsh itself checks a plugin's `@deepseek-ai/dsh*` peer ranges against the runtime
  and disables incompatible profile rows — the resume plugin must list the new version (after
  its tests pass on the new release), or the headless runner is disabled and runs hang silently;
- 0.2 removed `~/.dsh/settings.yaml`: its first run imports the file into whichever profile runs
  first and renames it `settings.yaml.imported` — shared sections belong in `~/.dsh/cordis.patch.yml`.

Precedent of a silent break: 0.1.1-rc.2 tightened the `reasoningEfforts` schema and dropped
the entire model catalog on new processes, while an already-running web instance kept working.

## Checklist (after `activate`, on a new process)

- [ ] `dsh --version` matches the catalog's `expected_version_pattern`.
- [ ] The model catalog is alive: running any headless run does not fail with
      `NO_ADAPTER: no adapter registered for provider "omniroute"`.
- [ ] The patch applied: `dsh --profile headless --dump-config` contains the
      resume plugin's entry (otherwise `- insert` did not fire — check the entry id).
- [ ] The plugin is not refused: the same `--dump-config` run prints no
      `is incompatible with dsh` on stderr (the entry still shows up in the dump when refused).
- [ ] Fresh run: `dsh --profile headless "print ok"` → the last line of stdout is a
      valid Envelope v1 (`{"v":1,...,"status":"completed",...}`) with a non-empty
      `sessionId`.
- [ ] Resume run: `dsh --profile headless --resume <sessionId> "continue"` →
      the same `sessionId`, `status:"completed"`.
- [ ] Failing resume: `--resume no-such-session` → envelope
      `status:"error"`, code `resume_not_found`, exit≠0.
- [ ] Run through the bridge: `dsh-bridge run --task-file <file>` → the envelope
      is passed through without distortion, the run registry is clean (`dsh-bridge list`).
- [ ] One live run of `dsh_task` from an OMP session: the stream is visible, the result
      comes back.

A red item means the update is not closed — roll back the release through the hosting
toolchain's standard rollback mechanism.

## What to record afterward

- The outcome (what broke / what was fixed) — in the `dsh` project's Engram.
- Reproducible pitfalls of the DSH release itself — in `error-bank`.
