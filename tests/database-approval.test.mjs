import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OfficeDatabase } from "../orchestrator/db.ts";

test("reused app-server request ids replace every approval field", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-office-approval-"));
  const database = new OfficeDatabase(path.join(directory, "office.db"));

  database.addApproval({
    requestId: "0",
    createdAt: "2026-07-17T15:00:35.527Z",
    agentId: "engineer",
    threadId: "old-thread",
    turnId: "old-turn",
    method: "item/fileChange/requestApproval",
    summary: "old approval",
    params: { availableDecisions: ["accept", "cancel"] },
    status: "pending",
  });
  database.setApprovalStatus("0", "approved");
  database.addApproval({
    requestId: "0",
    createdAt: "2026-07-22T13:00:00.000Z",
    agentId: "pm",
    threadId: "new-thread",
    turnId: "new-turn",
    method: "item/commandExecution/requestApproval",
    summary: "new approval",
    params: { command: "npm test", availableDecisions: ["accept", "cancel"] },
    status: "pending",
  });

  assert.deepEqual(database.getApproval("0"), {
    requestId: "0",
    createdAt: "2026-07-22T13:00:00.000Z",
    agentId: "pm",
    threadId: "new-thread",
    turnId: "new-turn",
    method: "item/commandExecution/requestApproval",
    summary: "new approval",
    params: { command: "npm test", availableDecisions: ["accept", "cancel"] },
    status: "pending",
  });

  rmSync(directory, { recursive: true, force: true });
});
