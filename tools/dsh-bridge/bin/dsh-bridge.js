#!/usr/bin/env node
import { runDsh } from '../src/run.js';
import { listRuns, reapOrphans, readRegistry } from '../src/registry.js';
import { envelopeToJsonLine } from '../src/envelope.js';
import { parseModelSpec } from '../src/model-spec.js';
import { reapExpiredRuns, killRun } from '../src/async-run.js';

function usage() {
  console.log(`dsh-bridge — bridge-core CLI (debug)

Usage:
  dsh-bridge run --task-file <path> [--resume <sessionId>] [--model <provider/model[:effort]>] [--cwd <dir>] [--timeout <ms>]
  dsh-bridge kill <runId>
  dsh-bridge list
  dsh-bridge reap            # finish off expired runs and clean up completed entries

Env:
  DSH_BINARY        override dsh binary (for tests)
  DSH_BRIDGE_RUNS_FILE  override registry file
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  return { cmd, rest: args.slice(1) };
}

function getOpt(rest, name) {
  const idx = rest.indexOf(name);
  if (idx === -1) return null;
  return rest[idx + 1] ?? null;
}

function hasOpt(rest, name) {
  return rest.includes(name);
}

async function cmdRun(rest) {
  const taskFile = getOpt(rest, '--task-file');
  if (!taskFile) {
    console.error('error: --task-file <path> is required');
    process.exit(2);
  }
  const resume = getOpt(rest, '--resume');
  const hasModel = rest.includes('--model');
  const modelRaw = getOpt(rest, '--model');
  let model;
  if (hasModel) {
    if (modelRaw === null || modelRaw.startsWith('--')) {
      console.error('error: --model <provider/model[:effort]> is required');
      process.exit(2);
    }
    try {
      model = parseModelSpec(modelRaw);
    } catch (e) {
      console.error(`error: --model ${e.message}`);
      process.exit(2);
    }
  }
  const cwd = getOpt(rest, '--cwd') || process.cwd();
  const timeoutRaw = getOpt(rest, '--timeout');
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutRaw && !Number.isFinite(timeoutMs)) {
    console.error('error: --timeout must be a number');
    process.exit(2);
  }

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

  let lastJsonLine = null;
  const envelope = await runDsh({
    taskFile,
    resumeSessionId: resume || undefined,
    cwd,
    timeoutMs,
    model,
    signal: ac.signal,
    onStdout: (chunk) => {
      process.stdout.write(chunk);
      // Accumulate last complete JSON line for deep-equal suppression check (P1 fix):
      // only suppress printing runDsh result if the last stdout JSON line is already exactly that envelope.
      const lines = chunk.split('\n');
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            JSON.parse(trimmed);
            lastJsonLine = trimmed;
          } catch {}
        }
      }
    },
  });

  let suppress = false;
  if (lastJsonLine !== null) {
    try {
      const parsed = JSON.parse(lastJsonLine);
      // deep-equal via canonical JSON string comparison (envelope keys are stable, envelopeToJsonLine uses JSON.stringify)
      suppress = JSON.stringify(parsed) === JSON.stringify(envelope);
    } catch {
      suppress = false;
    }
  }
  if (!suppress) {
    const line = envelopeToJsonLine(envelope);
    process.stdout.write(`${line}\n`);
  }
  process.exit(0);
}

async function cmdKill(rest) {
  const runId = rest[0];
  if (!runId) {
    console.error('usage: dsh-bridge kill <runId>');
    process.exit(2);
  }
  const reg = await readRegistry();
  if (!reg[runId]) {
    console.error(`run not found: ${runId}`);
    process.exit(1);
  }
  // killRun (async-run.js), а не прямые killPgid/killPid по данным реестра:
  // identity-проверка против переиспользованного ОС pid уже внутри — в том
  // числе перед SIGKILL-эскалацией (P1 п.3, раунд 2 кросс-ревью). CLI не
  // должен дублировать эту логику и рисковать сигналом в чужой живой процесс.
  const result = await killRun(runId);
  console.log(`kill ${runId}: ${result.killed ? 'killed' : 'not killed'} (${result.state})`);
}

async function cmdList() {
  const reg = await listRuns();
  const entries = Object.entries(reg);
  if (entries.length === 0) {
    console.log('(no runs)');
    return;
  }
  for (const [runId, e] of entries) {
    console.log(
      `${runId}  pid=${e.pid} pgid=${e.pgid} state=${e.state} startedAt=${e.startedAt} session=${e.dshSessionId ?? '-'}`,
    );
  }
}

async function cmdReap() {
  // Порядок важен: сначала добить просроченные раны (они ЖИВЫ и потому
  // reapOrphans их не трогает), только потом вычистить завершённые записи.
  const expired = await reapExpiredRuns();
  for (const runId of expired.killed) {
    console.log(`expired: ${runId} (${expired.reasons[runId]})`);
  }
  const res = await reapOrphans();
  console.log(`reaped: expired=${expired.killed.length} removed=${res.removed.length} killed=${res.killed.length}`);
  if (res.removed.length) console.log(`  removed: ${res.removed.join(', ')}`);
  if (res.killed.length) console.log(`  killed: ${res.killed.join(', ')}`);
}

async function main() {
  const { cmd, rest } = parseArgs(process.argv);
  if (!cmd || hasOpt(process.argv, '--help') || hasOpt(process.argv, '-h')) {
    usage();
    process.exit(cmd ? 0 : 2);
  }
  switch (cmd) {
    case 'run':
      await cmdRun(rest);
      break;
    case 'kill':
      await cmdKill(rest);
      break;
    case 'list':
      await cmdList();
      break;
    case 'reap':
      await cmdReap();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
