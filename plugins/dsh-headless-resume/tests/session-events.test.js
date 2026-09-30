import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionEvents, summarize, modelOfRun } from "../src/index.js";

// dsh 0.1.5-rc.1 убрал у сессии массив `events`: upstream dsh-headless читает
// журнал как session.seq + session.eventAt(SessionSeq(n)). Плагин обязан
// говорить на том же контракте, иначе summarize падает "events is not iterable".
// Держим и старый путь: откат dsh на 0.1.1-rc.2 не должен ломать плагин.
const EV = [
  { seq: 0, type: "turn/start", data: { turn: 1 } },
  { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } },
  { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
];

const newStyle = (events) => ({
  seq: events.length,
  eventAt: (n) => events[Number(n)],
});
const oldStyle = (events) => ({ events });

describe("sessionEvents()", () => {
  it("читает сессию нового dsh через seq + eventAt", () => {
    assert.deepEqual([...sessionEvents(newStyle(EV))], EV);
  });

  it("читает сессию старого dsh через массив events", () => {
    assert.deepEqual([...sessionEvents(oldStyle(EV))], EV);
  });

  it("новый путь имеет приоритет, если есть оба", () => {
    const s = { ...newStyle(EV), events: [] };
    assert.equal([...sessionEvents(s)].length, EV.length);
  });

  it("на битой сессии отдаёт пусто, а не бросает", () => {
    for (const s of [undefined, null, {}, { seq: 3 }, { events: "не массив" }]) {
      assert.deepEqual([...sessionEvents(s)], []);
    }
  });

  it("пропускает дыры в журнале, не падая", () => {
    const s = { seq: 3, eventAt: (n) => (Number(n) === 1 ? undefined : EV[Number(n)]) };
    assert.deepEqual(
      [...sessionEvents(s)].map((e) => e.seq),
      [0, 2],
    );
  });
});

describe("summarize() поверх сессии нового dsh", () => {
  it("собирает текст и причину — то, что падало как «events is not iterable»", () => {
    const { text, reason } = summarize(sessionEvents(newStyle(EV)), 0);
    assert.equal(text, "ok");
    assert.deepEqual(reason, { kind: "completed" });
  });
});

describe("modelOfRun() поверх сессии нового dsh", () => {
  const withHeader = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    {
      seq: 1,
      type: "request/header",
      data: { header: { config: { provider: "omniroute", model: "deepseek-v4-pro", reasoningEffort: "high" } } },
    },
    { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];

  it("достаёт провайдера и модель, а не молча undefined", () => {
    const agent = { session: newStyle(withHeader) };
    assert.deepEqual(modelOfRun(agent, 0), {
      provider: "omniroute",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    });
  });
});
