import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSteerLine, readNewLines, startSteerChannel, POLL_INTERVAL_MS } from "../src/steer-channel.js";

let dir;
let steerFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steer-test-"));
  steerFile = join(dir, "run.steer.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Ручной таймер: тест сам решает, когда произошёл опрос. */
function manualTimer() {
  const ticks = [];
  return {
    setIntervalFn: (fn) => {
      ticks.push(fn);
      return { unref() {} };
    },
    clearIntervalFn: () => {
      ticks.length = 0;
    },
    tick() {
      for (const fn of [...ticks]) fn();
    },
  };
}

function fakeAgent() {
  const steered = [];
  return {
    agent: { steer: (msg) => steered.push(msg) },
    steered,
  };
}

const createUserMessage = (m) => m;
const textOf = (msg) => msg.content[0].text;

function line(text) {
  return `${JSON.stringify({ v: 1, text, sentAt: "2026-08-24T12:00:00.000Z" })}\n`;
}

describe("parseSteerLine()", () => {
  it("returns text for a valid line", () => {
    assert.equal(parseSteerLine(line("привет").trim()), "привет");
  });

  it("rejects malformed JSON, non-objects, arrays and empty text", () => {
    for (const bad of [
      "{не json",
      "null",
      "42",
      '"строка"',
      "[1,2]",
      '{"v":1}',
      '{"v":1,"text":""}',
      '{"v":1,"text":5}',
      "   ",
    ]) {
      assert.equal(parseSteerLine(bad), null, `должно быть отвергнуто: ${bad}`);
    }
  });
});

describe("readNewLines()", () => {
  it("missing file is normal: no lines, offset unchanged", () => {
    assert.deepEqual(readNewLines(steerFile, 0), { lines: [], offset: 0 });
  });

  it("ignores a trailing partial line until its newline arrives", () => {
    writeFileSync(steerFile, `${line("первая")}{"v":1,"text":"хвост"`, "utf8");
    const first = readNewLines(steerFile, 0);
    assert.equal(first.lines.length, 1);
    assert.equal(parseSteerLine(first.lines[0]), "первая");

    // Дописали перевод строки — хвост стал целой строкой.
    appendFileSync(steerFile, "}\n", "utf8");
    const second = readNewLines(steerFile, first.offset);
    assert.equal(second.lines.length, 1);
    assert.equal(parseSteerLine(second.lines[0]), "хвост");
  });

  it("advances offset by bytes, not characters (utf8 safety)", () => {
    writeFileSync(steerFile, line("ёжик"), "utf8");
    const { offset } = readNewLines(steerFile, 0);
    assert.equal(offset, statSync(steerFile).size, "offset должен совпасть с размером файла");
  });
});

describe("startSteerChannel()", () => {
  it("delivers one message to agent.steer with the runner's message shape", () => {
    const timer = manualTimer();
    const { agent, steered } = fakeAgent();
    writeFileSync(steerFile, line("пиши в src/"), "utf8");

    const channel = startSteerChannel(agent, steerFile, { createUserMessage, ...timer });
    timer.tick();
    channel.stop();

    assert.equal(steered.length, 1);
    assert.equal(textOf(steered[0]), "пиши в src/");
    assert.deepEqual(steered[0].source, { kind: "user" });
  });

  it("preserves order and does not duplicate across polls", () => {
    const timer = manualTimer();
    const { agent, steered } = fakeAgent();
    const channel = startSteerChannel(agent, steerFile, { createUserMessage, ...timer });

    writeFileSync(steerFile, line("раз") + line("два"), "utf8");
    timer.tick();
    timer.tick(); // повторный опрос не должен продублировать
    appendFileSync(steerFile, line("три"), "utf8");
    timer.tick();
    channel.stop();

    assert.deepEqual(steered.map(textOf), ["раз", "два", "три"]);
  });

  it("skips a malformed line, warns, and keeps processing the rest", () => {
    const timer = manualTimer();
    const { agent, steered } = fakeAgent();
    const warnings = [];
    writeFileSync(steerFile, `${line("до")}{битая строка\n${line("после")}`, "utf8");

    const channel = startSteerChannel(agent, steerFile, {
      createUserMessage,
      onWarn: (m) => warnings.push(m),
      ...timer,
    });
    timer.tick();
    channel.stop();

    assert.deepEqual(steered.map(textOf), ["до", "после"]);
    assert.equal(warnings.length, 1);
  });

  it("writes .offset so undelivered bytes are visible to the caller", () => {
    const timer = manualTimer();
    const { agent } = fakeAgent();
    writeFileSync(steerFile, line("прочитано"), "utf8");

    const channel = startSteerChannel(agent, steerFile, { createUserMessage, ...timer });
    timer.tick();

    // Сообщение пришло после того, как ход уже закончился: канал остановлен
    // ниже, но stop() делает финальный дренаж — поэтому пишем ПОСЛЕ stop().
    channel.stop();
    appendFileSync(steerFile, line("опоздало"), "utf8");

    const offset = Number(readFileSync(`${steerFile}.offset`, "utf8"));
    assert.ok(Number.isInteger(offset), ".offset должен содержать число");
    assert.ok(offset < statSync(steerFile).size, "расхождение размера и offset = недоставленное сообщение");
  });

  it("stop() drains what arrived between ticks, then delivers nothing more", () => {
    const timer = manualTimer();
    const { agent, steered } = fakeAgent();
    const channel = startSteerChannel(agent, steerFile, { createUserMessage, ...timer });

    writeFileSync(steerFile, line("между тиками"), "utf8");
    channel.stop(); // финальный дренаж внутри stop()
    assert.deepEqual(steered.map(textOf), ["между тиками"]);

    appendFileSync(steerFile, line("после остановки"), "utf8");
    timer.tick();
    assert.equal(steered.length, 1, "после stop() ничего не доставляется");
  });

  it("stop() is idempotent and clears the timer", () => {
    let cleared = 0;
    const { agent } = fakeAgent();
    const channel = startSteerChannel(agent, steerFile, {
      createUserMessage,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    channel.stop();
    channel.stop();
    assert.equal(cleared, 1, "таймер снимается ровно один раз");
  });

  it("real timer is unref'd so it cannot keep the process alive", () => {
    const { agent } = fakeAgent();
    let unrefCalled = false;
    const channel = startSteerChannel(agent, steerFile, {
      createUserMessage,
      setIntervalFn: () => ({
        unref() {
          unrefCalled = true;
        },
      }),
      clearIntervalFn: () => {},
    });
    channel.stop();
    assert.equal(unrefCalled, true);
  });

  it("no file at all: nothing delivered, no crash", () => {
    const timer = manualTimer();
    const { agent, steered } = fakeAgent();
    const channel = startSteerChannel(agent, steerFile, { createUserMessage, ...timer });
    timer.tick();
    channel.stop();
    assert.equal(steered.length, 0);
    assert.equal(existsSync(steerFile), false);
  });

  it("poll interval is 150ms per contract", () => {
    assert.equal(POLL_INTERVAL_MS, 150);
  });
});
