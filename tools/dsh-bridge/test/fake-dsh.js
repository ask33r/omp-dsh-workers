#!/usr/bin/env node
// Fake dsh binary for bridge-core unit tests.
// Parses: --profile headless [--patch PATH] [--resume ID] <task...>
// Behavior driven by task content markers.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';

// В Node нет process.getpgid/getpgrp — pgid читаем из /proc/self/stat (после "(comm)": state ppid pgrp).
function ownPgid() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  // argv includes node, script, then real args
  // But spawn("fake-dsh.js", ["--profile","headless",...]) passes args after script as argv[2..]
  // When executed as binary via shebang, argv[1] is script path, args start at 2.
  // When DSH_BINARY is this file and spawn uses it directly, Node will exec it.
  // Handle both: find --profile
  const args = argv.slice(2);
  let resume = null;
  const taskParts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && i + 1 < args.length) {
      resume = args[i + 1];
      i++;
    } else if (args[i] === '--profile' && i + 1 < args.length) {
      // skip profile name
      i++;
    } else if (args[i] === '--patch' && i + 1 < args.length) {
      // skip overlay path (lean worker patch)
      i++;
    } else {
      taskParts.push(args[i]);
    }
  }
  const task = taskParts.join(' ');
  return { resume, task, rawArgs: args };
}

const { resume, task, rawArgs } = parseArgs(process.argv);

// Тест «реестр не смог записаться после спавна» (startDsh/runDsh должны убить
// процесс, если putRun упал): бридж может прибить нас SIGKILL почти сразу
// после спавна, ещё до того, как мы дойдём до какой-либо ветки поведения —
// поэтому pid пишем максимально рано, синхронно, до всего остального.
if (process.env.FAKE_PIDFILE) {
  try {
    writeFileSync(process.env.FAKE_PIDFILE, String(process.pid), 'utf8');
  } catch {}
}

// Diagnostics log for argv/env/pgid checks
const logFile = process.env.FAKE_DSH_LOG;
if (logFile) {
  try {
    const info = {
      pid: process.pid,
      pgid: ownPgid(),
      ppid: process.ppid,
      argv: process.argv.slice(2),
      rawArgs,
      resume,
      taskPreview: task.slice(0, 200),
      taskLength: task.length,
      env: { ...process.env },
      cwd: process.cwd(),
    };
    appendFileSync(logFile, `${JSON.stringify(info)}\n`, 'utf8');
  } catch {}
}

// Helper to write envelope helper
function printEnvelope(env) {
  process.stdout.write(`${JSON.stringify(env)}\n`);
}

/**
 * runId для веток, печатающих envelope. FAKE_ENVELOPE_RUNID первым — это
 * ЯВНАЯ подмена, которую заводит тест дефекта 5 (envelope runId mismatch),
 * и она обязана побеждать. DSH_RUN_ID вторым — его всегда передаёт bridge
 * (startDsh/runDsh), так что штатные тесты без подмены получают envelope,
 * который совпадает с настоящим runId рана и проходит новую проверку
 * совпадения. 'test-run-id' — только если фикстуру дёрнули вообще не через
 * bridge (DSH_RUN_ID не задан).
 */
function envelopeRunId() {
  return process.env.FAKE_ENVELOPE_RUNID || process.env.DSH_RUN_ID || 'test-run-id';
}

// Child spawn for pgid test
function spawnChildSleep() {
  // Use a short sleep so the test suite does not leak 60s processes when
  // pgid kill races with reparenting. 10s is enough to verify pgid kill.
  const child = spawn('sleep', ['10'], { detached: false, stdio: 'ignore' });
  const childLog = process.env.FAKE_DSH_CHILD_LOG;
  if (childLog) {
    try {
      writeFileSync(childLog, String(child.pid), 'utf8');
    } catch {}
  }
  child.unref();
}

// Signal handling: ensure SIGTERM exits (default does, but hang mode overrides)
const hangMode =
  task.includes('__FAKE_HANG__') || task.includes('__FAKE_SPAWN_CHILD__') || task.includes('__FAKE_STEER_READER__');
if (hangMode) {
  // In hang mode, we trap SIGTERM to test timeout kill — but still exit on SIGTERM after logging
  // Actually we want to test that bridge's SIGTERM kills us; so just handle gracefully.
  process.on('SIGTERM', () => {
    // Exit with 143 (128+15) to indicate SIGTERM
    process.exit(143);
  });
  process.on('SIGINT', () => process.exit(130));
}

// __FAKE_IGNORE_TERM__ — НАМЕРЕННО не входит в hangMode выше: тому набору
// нужен SIGTERM, которым процесс аккуратно завершается (эмуляция обычной
// задачи под таймаутом/kill), а этому маркеру — ровно обратное: процесс,
// который SIGTERM не берёт вовсе. Нужен тестам эскалации SIGKILL (повторная
// проверка identity перед эскалацией, гонка claim vs renewLease в reaper) —
// им важно, чтобы единственный способ прибить процесс был SIGKILL, который
// перехватить нельзя в принципе.
if (task.includes('__FAKE_IGNORE_TERM__')) {
  process.on('SIGTERM', () => {});
}

// Branch behaviors
if (task.includes('__FAKE_SPAWN_CHILD__')) {
  spawnChildSleep();
  // Then hang forever (until SIGTERM)
  setInterval(() => {}, 1000);
  // Keep process alive
} else if (task.includes('__FAKE_HANG__')) {
  // Hang indefinitely
  setInterval(() => {}, 1000);
} else if (task.includes('__FAKE_IGNORE_TERM__')) {
  // SIGTERM-обработчик уже поставлен выше (до branch behaviors) — здесь
  // только сам hang, чтобы не дублировать место, отвечающее за сигнал.
  setInterval(() => {}, 1000);
} else if (task.includes('__FAKE_STEER_READER__')) {
  // Имитация Cordis-плагина стиринга (steer-channel.js): раз в 50 мс дочитывает
  // канал целиком и обновляет `<steerFile>.offset` байтовым размером прочитанного.
  // Нужна тестам честного delivered в sendToRun — без неё канал никто не читает,
  // и delivered должен становиться false (см. __FAKE_HANG__ для этого случая).
  const steerFile = process.env.DSH_STEER_FILE;
  if (steerFile) {
    setInterval(() => {
      try {
        const size = readFileSync(steerFile).length; // байты, не символы — как pendingBytesOf
        writeFileSync(`${steerFile}.offset`, String(size), 'utf8');
      } catch {
        // Канал ещё не создан (sendToRun ещё не звал) — попробуем на следующем тике.
      }
    }, 50);
  }
  setInterval(() => {}, 1000);
} else if (task.includes('__FAKE_NEED_INPUT__')) {
  const question = task.replace('__FAKE_NEED_INPUT__', '').trim() || 'нужен ответ';
  process.stdout.write(`${question}\n`);
  process.stdout.write(
    `${JSON.stringify({
      v: 1,
      runId: envelopeRunId(),
      sessionId: resume || 'session-need-input',
      status: 'need_input',
      question,
    })}\n`,
  );
  process.exit(0);
} else if (task.includes('__FAKE_DUMP_ENV__')) {
  // Печатает сквозные переменные, которые bridge обязан передать раннеру.
  process.stdout.write(`DSH_RUN_ID=${process.env.DSH_RUN_ID ?? ''}\n`);
  process.stdout.write(`DSH_STEER_FILE=${process.env.DSH_STEER_FILE ?? ''}\n`);
  process.stdout.write(`DSH_MODEL_PROVIDER=${process.env.DSH_MODEL_PROVIDER ?? ''}\n`);
  process.stdout.write(`DSH_MODEL=${process.env.DSH_MODEL ?? ''}\n`);
  process.stdout.write(`DSH_REASONING_EFFORT=${process.env.DSH_REASONING_EFFORT ?? ''}\n`);
  process.exit(0);
} else if (task.includes('__FAKE_EXIT1__')) {
  process.stderr.write('simulated failure: something went wrong\n');
  process.exit(1);
} else if (task.includes('__FAKE_RESUME_NOT_FOUND__')) {
  process.stderr.write('resume_not_found: session does not exist\n');
  process.exit(1);
} else if (task.includes('__FAKE_RESUME_CORRUPT__')) {
  process.stderr.write('resume_corrupt: session file is corrupted\n');
  process.exit(1);
} else if (task.includes('__FAKE_RESUME_BUSY__')) {
  process.stderr.write('resume_busy: session already in use\n');
  process.exit(1);
} else if (task.includes('__FAKE_MALFORMED__')) {
  // Print some text, then invalid envelope JSON (bad shape)
  process.stdout.write('some output before\n');
  process.stdout.write('{"v":1,"runId":"bad"}\n'); // missing required fields -> malformed
  process.exit(0);
} else if (task.includes('__FAKE_MALFORMED_JSON__')) {
  process.stdout.write('output\n');
  process.stdout.write('not json at all\n');
  process.exit(0);
  // But this will be treated as no envelope -> synthesized completed, not malformed.
  // So to trigger malformed we need invalid v1 shape as last line.
} else if (task.includes('__FAKE_ENVELOPE_OK__')) {
  // Simulate phase 2: dsh prints envelope itself
  const runId = envelopeRunId();
  const sessionId = resume || process.env.FAKE_ENVELOPE_SESSION || 'session-abc-123';
  // task without marker as result
  const cleanTask = task.replace('__FAKE_ENVELOPE_OK__', '').trim();
  const env = {
    v: 1,
    runId,
    sessionId,
    status: 'completed',
    result: cleanTask || 'envelope result',
  };
  // Optionally add some stdout before envelope
  if (cleanTask) process.stdout.write(`prefix output: ${cleanTask}\n`);
  printEnvelope(env);
  process.exit(0);
} else if (task.includes('__FAKE_ENVELOPE_NEED_INPUT__')) {
  const runId = envelopeRunId();
  const sessionId = resume || 'session-need-input';
  const env = {
    v: 1,
    runId,
    sessionId,
    status: 'need_input',
    question: 'What is your name?',
  };
  printEnvelope(env);
  process.exit(0);
} else if (task.includes('__FAKE_ENVELOPE_ERROR__')) {
  const runId = envelopeRunId();
  const env = {
    v: 1,
    runId,
    sessionId: resume || null,
    status: 'error',
    error: { code: 'resume_not_found', message: 'session not found', exitCode: 1 },
  };
  printEnvelope(env);
  process.exit(1);
} else if (task.includes('__FAKE_ENVELOPE_WITH_MODEL__')) {
  const runId = envelopeRunId();
  const sessionId = resume || 'session-abc-123';
  let model;
  try {
    model = JSON.parse(process.env.FAKE_ENVELOPE_MODEL || '');
  } catch {
    model = null;
  }
  const env = { v: 1, runId, sessionId, status: 'completed', result: 'ok', model };
  // If model parse failed, put invalid to trigger malformed
  if (!model) env.model = process.env.FAKE_ENVELOPE_MODEL;
  printEnvelope(env);
  process.exit(0);
} else if (task.includes('__FAKE_ENVELOPE_BAD_MODEL__')) {
  const runId = envelopeRunId();
  const env = {
    v: 1,
    runId,
    sessionId: 'session-abc-123',
    status: 'completed',
    result: 'ok',
    model: { provider: '', model: 'x' },
  };
  printEnvelope(env);
  process.exit(0);
} else {
  // Normal success: echo task as stdout

  process.stdout.write(`${task}\n`);
  process.exit(0);
}
