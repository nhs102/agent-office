import assert from "node:assert/strict";
import test from "node:test";

import {
  isDiscordVerificationCommand,
  normalizeDiscordProgressText,
} from "../orchestrator/discord-progress.ts";

test("recognizes verification commands without treating normal shell work as QA", () => {
  assert.equal(isDiscordVerificationCommand("npm run build"), true);
  assert.equal(isDiscordVerificationCommand("npm run lint"), true);
  assert.equal(isDiscordVerificationCommand("pnpm test"), true);
  assert.equal(isDiscordVerificationCommand("npx tsc --noEmit"), true);
  assert.equal(isDiscordVerificationCommand("npm run dev"), false);
  assert.equal(isDiscordVerificationCommand("git status --short"), false);
});

test("keeps progress readable and removes report-only wrappers", () => {
  assert.equal(
    normalizeDiscordProgressText(
      "<office_summary>구현 중이에요.</office_summary>\n\n\n다음 단계로 갑니다.",
    ),
    "구현 중이에요.\n\n다음 단계로 갑니다.",
  );
});
