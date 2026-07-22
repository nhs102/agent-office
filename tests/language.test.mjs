import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOfficeLanguage,
  officeLanguageInstruction,
  officeLanguageText,
} from "../orchestrator/language.ts";

test("detects English requests while keeping Korean technical prompts Korean", () => {
  assert.equal(
    detectOfficeLanguage("Build a brand-new LinkedIn feed demo from scratch."),
    "en",
  );
  assert.equal(
    detectOfficeLanguage("LinkedIn 데모 사이트 새로 만들어줘"),
    "ko",
  );
});

test("provides strict same-language instructions and localized system copy", () => {
  assert.match(officeLanguageInstruction("en"), /natural English only/);
  assert.match(officeLanguageInstruction("en"), /Do not use Korean/);
  assert.equal(officeLanguageText("en", "시작", "Starting"), "Starting");
  assert.equal(officeLanguageText("ko", "시작", "Starting"), "시작");
});
