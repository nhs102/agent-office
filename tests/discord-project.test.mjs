import assert from "node:assert/strict";
import test from "node:test";

import {
  discordProjectTagNames,
  discordProjectThreadName,
} from "../orchestrator/discord-project.ts";

test("maps project lifecycle to the configured forum tag aliases", () => {
  assert.ok(discordProjectTagNames("working").includes("in progress"));
  assert.ok(discordProjectTagNames("complete").includes("completed"));
  assert.ok(discordProjectTagNames("failed").includes("paused"));
});

test("keeps project thread names clean and replaces lifecycle icons", () => {
  assert.equal(
    discordProjectThreadName("LinkedIn Feed Demo", "working"),
    "🚀 LinkedIn Feed Demo",
  );
  assert.equal(
    discordProjectThreadName("🚀 LinkedIn Feed Demo", "complete"),
    "✅ LinkedIn Feed Demo",
  );
  assert.equal(
    discordProjectThreadName("Line one\nLine two", "failed"),
    "⚠️ Line one Line two",
  );
});
