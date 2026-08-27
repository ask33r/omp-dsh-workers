import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headlessResumeCommand } from "../src/startup.js";

describe("headlessResumeCommand()", () => {
  it("parses positional task", () => {
    const p = headlessResumeCommand();
    p.exitOverride();
    p.parse(["hello", "world"], { from: "user" });
    assert.equal(p.opts().resume, undefined);
    assert.equal(p.args.join(" "), "hello world");
  });

  it("parses --resume with task", () => {
    const p = headlessResumeCommand();
    p.exitOverride();
    p.parse(["--resume", "sess-123", "continue", "task"], { from: "user" });
    assert.equal(p.opts().resume, "sess-123");
    assert.equal(p.args.join(" "), "continue task");
  });

  it("parses --resume after task", () => {
    const p = headlessResumeCommand();
    p.exitOverride();
    p.parse(["continue", "--resume", "sess-xyz"], { from: "user" });
    assert.equal(p.opts().resume, "sess-xyz");
  });

  it("trims resume id (raw commander preserves, startup trims)", () => {
    const p = headlessResumeCommand();
    p.exitOverride();
    p.parse(["--resume", "  sess-1  ", "task"], { from: "user" });
    assert.equal(p.opts().resume, "  sess-1  ");
  });

  it("exposes --help", () => {
    const p = headlessResumeCommand();
    const help = p.helpInformation();
    assert.match(help, /--resume/);
    assert.match(help, /--help/);
  });
});
