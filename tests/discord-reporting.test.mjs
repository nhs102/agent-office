import assert from "node:assert/strict";
import test from "node:test";
import { shouldReportDiscordWork } from "../orchestrator/discord-reporting.ts";

test("reports project work but ignores casual Discord chat", () => {
  assert.equal(shouldReportDiscordWork("[프로젝트] 에이전트 대시보드 개편"), true);
  assert.equal(shouldReportDiscordWork("프로젝트: 디스코드 관제 시스템"), true);
  assert.equal(shouldReportDiscordWork("디스코드 응답 오류를 수정하고 테스트해줘"), true);
  assert.equal(shouldReportDiscordWork("노션 연결 상태 점검해줘"), true);
  assert.equal(shouldReportDiscordWork("[PROJECT] Build a launch checklist"), true);
  assert.equal(shouldReportDiscordWork("Build a small polished web app"), true);
  assert.equal(shouldReportDiscordWork("Review the Discord integration"), true);
  assert.equal(shouldReportDiscordWork("반갑다 제군들 다들 자기 소개 한 번씩 해봐라"), false);
  assert.equal(shouldReportDiscordWork("오늘 저녁 뭐 먹지?"), false);
  assert.equal(shouldReportDiscordWork("@everyone 저메추"), false);
  assert.equal(shouldReportDiscordWork("현재 토큰 얼마나 썼어?"), false);
  assert.equal(shouldReportDiscordWork("[잡담] 코드 이야기 좀 해줘"), false);
  assert.equal(shouldReportDiscordWork("[chat] Tell me about web apps"), false);
  assert.equal(shouldReportDiscordWork("Tell me a joke about code"), false);
});
