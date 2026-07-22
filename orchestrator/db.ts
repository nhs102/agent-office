/* SQLite rows cross a runtime boundary and are normalized before export. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentDefinition,
  AgentRecord,
  AgentStatus,
  ApprovalRecord,
  OfficeEvent,
  ProjectDefinition,
  TokenUsage,
  WorkerRecord,
} from "./types";

const emptyUsage: TokenUsage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class OfficeDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        short_role TEXT NOT NULL,
        color TEXT NOT NULL,
        accent TEXT NOT NULL,
        seat_x REAL NOT NULL,
        seat_y REAL NOT NULL,
        cwd TEXT NOT NULL,
        sandbox TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        developer_instructions TEXT NOT NULL,
        model TEXT,
        thread_id TEXT,
        active_turn_id TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        activity TEXT NOT NULL DEFAULT '연결 대기 중',
        last_message TEXT NOT NULL DEFAULT '',
        last_event_at TEXT,
        usage_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_thread_id
        ON agents(thread_id) WHERE thread_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        description TEXT NOT NULL,
        notion_page_id TEXT,
        obsidian_path TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(id DESC);
      CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        agent_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        method TEXT NOT NULL,
        summary TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS workers (
        thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT,
        parent_agent_id TEXT,
        nickname TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        activity TEXT NOT NULL,
        spawned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notion_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        agent_id TEXT NOT NULL,
        page_id TEXT NOT NULL UNIQUE,
        page_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'working',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notion_tasks_turn
        ON notion_tasks(turn_id, status);
      CREATE INDEX IF NOT EXISTS idx_notion_tasks_agent
        ON notion_tasks(agent_id, status);

      CREATE TABLE IF NOT EXISTS discord_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        source_message_id TEXT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'working',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_discord_tasks_turn
        ON discord_tasks(turn_id, status);
      CREATE INDEX IF NOT EXISTS idx_discord_tasks_agent
        ON discord_tasks(agent_id, status);
    `);
    const discordTaskColumns = this.db
      .prepare("PRAGMA table_info(discord_tasks)")
      .all() as Array<{ name: string }>;
    if (!discordTaskColumns.some((column) => column.name === "report_to_forum")) {
      this.db.exec(
        "ALTER TABLE discord_tasks ADD COLUMN report_to_forum INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!discordTaskColumns.some((column) => column.name === "source_message_id")) {
      this.db.exec(
        "ALTER TABLE discord_tasks ADD COLUMN source_message_id TEXT",
      );
    }
    if (!discordTaskColumns.some((column) => column.name === "project_thread_id")) {
      this.db.exec(
        "ALTER TABLE discord_tasks ADD COLUMN project_thread_id TEXT",
      );
    }
    if (!discordTaskColumns.some((column) => column.name === "response_language")) {
      this.db.exec(
        "ALTER TABLE discord_tasks ADD COLUMN response_language TEXT NOT NULL DEFAULT 'ko'",
      );
    }
  }

  seedAgents(agents: AgentDefinition[]) {
    const statement = this.db.prepare(`
      INSERT INTO agents (
        id, name, role, short_role, color, accent, seat_x, seat_y, cwd,
        sandbox, approval_policy, developer_instructions, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        short_role = excluded.short_role,
        color = excluded.color,
        accent = excluded.accent,
        seat_x = excluded.seat_x,
        seat_y = excluded.seat_y,
        cwd = excluded.cwd,
        sandbox = excluded.sandbox,
        approval_policy = excluded.approval_policy,
        developer_instructions = excluded.developer_instructions,
        model = excluded.model
    `);

    for (const agent of agents) {
      statement.run(
        agent.id,
        agent.name,
        agent.role,
        agent.shortRole,
        agent.color,
        agent.accent,
        agent.seat.x,
        agent.seat.y,
        agent.cwd,
        agent.sandbox,
        agent.approvalPolicy,
        agent.developerInstructions,
        agent.model ?? null,
      );
    }
  }

  seedProjects(projects: ProjectDefinition[]) {
    const statement = this.db.prepare(`
      INSERT INTO projects (
        id, name, status, cwd, owner_agent_id, description,
        notion_page_id, obsidian_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        cwd = excluded.cwd,
        owner_agent_id = excluded.owner_agent_id,
        description = excluded.description,
        notion_page_id = excluded.notion_page_id,
        obsidian_path = excluded.obsidian_path
    `);

    for (const project of projects) {
      statement.run(
        project.id,
        project.name,
        project.status,
        project.cwd,
        project.ownerAgentId,
        project.description,
        project.notionPageId ?? null,
        project.obsidianPath ?? null,
      );
    }
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY rowid").all() as any[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: String(row.role),
      shortRole: String(row.short_role),
      color: String(row.color),
      accent: String(row.accent),
      seat: { x: Number(row.seat_x), y: Number(row.seat_y) },
      cwd: String(row.cwd),
      sandbox: row.sandbox,
      approvalPolicy: row.approval_policy,
      developerInstructions: String(row.developer_instructions),
      model: row.model ? String(row.model) : undefined,
      threadId: row.thread_id ? String(row.thread_id) : null,
      activeTurnId: row.active_turn_id ? String(row.active_turn_id) : null,
      status: row.status as AgentStatus,
      activity: String(row.activity),
      lastMessage: String(row.last_message),
      lastEventAt: row.last_event_at ? String(row.last_event_at) : null,
      usage: {
        ...emptyUsage,
        ...parseJson<Partial<TokenUsage>>(row.usage_json, {}),
      },
    }));
  }

  getAgent(agentId: string): AgentRecord | null {
    return this.listAgents().find((agent) => agent.id === agentId) ?? null;
  }

  findAgentByThread(threadId: string | null | undefined): AgentRecord | null {
    if (!threadId) return null;
    const row = this.db
      .prepare("SELECT id FROM agents WHERE thread_id = ?")
      .get(threadId) as any;
    return row ? this.getAgent(String(row.id)) : null;
  }

  setAgentThread(agentId: string, threadId: string | null) {
    this.db
      .prepare(
        "UPDATE agents SET thread_id = ?, last_event_at = ? WHERE id = ?",
      )
      .run(threadId, new Date().toISOString(), agentId);
  }

  setAgentRuntime(
    agentId: string,
    status: AgentStatus,
    activity: string,
    activeTurnId?: string | null,
  ) {
    this.db
      .prepare(`
        UPDATE agents
        SET status = ?, activity = ?, active_turn_id = ?, last_event_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        activity,
        activeTurnId === undefined
          ? this.getAgent(agentId)?.activeTurnId ?? null
          : activeTurnId,
        new Date().toISOString(),
        agentId,
      );
  }

  setAgentMessage(agentId: string, message: string) {
    this.db
      .prepare(
        "UPDATE agents SET last_message = ?, last_event_at = ? WHERE id = ?",
      )
      .run(message.slice(0, 4000), new Date().toISOString(), agentId);
  }

  setAgentUsage(agentId: string, usage: TokenUsage) {
    this.db
      .prepare(
        "UPDATE agents SET usage_json = ?, last_event_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(usage), new Date().toISOString(), agentId);
  }

  setAgentModel(agentId: string, model: string) {
    this.db
      .prepare(
        "UPDATE agents SET model = ?, last_event_at = ? WHERE id = ?",
      )
      .run(model, new Date().toISOString(), agentId);
  }

  setAllDisconnected() {
    this.db
      .prepare(
        "UPDATE agents SET status = 'offline', activity = 'Codex 연결 대기 중', active_turn_id = NULL",
      )
      .run();
  }

  addEvent(input: Omit<OfficeEvent, "id" | "createdAt">): OfficeEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO events (
          created_at, type, agent_id, thread_id, turn_id, summary, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        createdAt,
        input.type,
        input.agentId,
        input.threadId,
        input.turnId,
        input.summary,
        JSON.stringify(input.payload ?? null),
      );

    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      ...input,
    };
  }

  listEvents(limit = 100): OfficeEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      createdAt: String(row.created_at),
      type: String(row.type),
      agentId: row.agent_id ? String(row.agent_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      summary: String(row.summary),
      payload: parseJson(row.payload_json, null),
    }));
  }

  addMessage(
    agentId: string,
    direction: "user" | "agent" | "system",
    text: string,
    threadId: string | null,
    turnId: string | null,
  ) {
    this.db
      .prepare(`
        INSERT INTO messages (
          created_at, agent_id, direction, text, thread_id, turn_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        new Date().toISOString(),
        agentId,
        direction,
        text.slice(0, 20000),
        threadId,
        turnId,
      );
  }

  addApproval(approval: ApprovalRecord) {
    this.db
      .prepare(`
        INSERT INTO approvals (
          request_id, created_at, agent_id, thread_id, turn_id,
          method, summary, params_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          created_at = excluded.created_at,
          agent_id = excluded.agent_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          method = excluded.method,
          summary = excluded.summary,
          params_json = excluded.params_json,
          status = excluded.status
      `)
      .run(
        approval.requestId,
        approval.createdAt,
        approval.agentId,
        approval.threadId,
        approval.turnId,
        approval.method,
        approval.summary,
        JSON.stringify(approval.params ?? null),
        approval.status,
      );
  }

  setApprovalStatus(requestId: string, status: ApprovalRecord["status"]) {
    this.db
      .prepare("UPDATE approvals SET status = ? WHERE request_id = ?")
      .run(status, requestId);
  }

  cancelPendingApprovals() {
    this.db
      .prepare("UPDATE approvals SET status = 'cancelled' WHERE status = 'pending'")
      .run();
  }

  getApproval(requestId: string): ApprovalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE request_id = ?")
      .get(requestId) as any;
    return row ? this.mapApproval(row) : null;
  }

  listPendingApprovals(): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC",
      )
      .all() as any[];
    return rows.map((row) => this.mapApproval(row));
  }

  upsertWorker(worker: WorkerRecord) {
    this.db
      .prepare(`
        INSERT INTO workers (
          thread_id, parent_thread_id, parent_agent_id, nickname, role,
          status, activity, spawned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          parent_agent_id = excluded.parent_agent_id,
          nickname = excluded.nickname,
          role = excluded.role,
          status = excluded.status,
          activity = excluded.activity,
          updated_at = excluded.updated_at
      `)
      .run(
        worker.threadId,
        worker.parentThreadId,
        worker.parentAgentId,
        worker.nickname,
        worker.role,
        worker.status,
        worker.activity,
        worker.spawnedAt,
        worker.updatedAt,
      );
  }

  listWorkers(): WorkerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workers ORDER BY updated_at DESC")
      .all() as any[];
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      parentThreadId: row.parent_thread_id
        ? String(row.parent_thread_id)
        : null,
      parentAgentId: row.parent_agent_id ? String(row.parent_agent_id) : null,
      nickname: String(row.nickname),
      role: String(row.role),
      status: row.status,
      activity: String(row.activity),
      spawnedAt: String(row.spawned_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as any;
    return row ? parseJson(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  addNotionTask(input: {
    turnId: string | null;
    agentId: string;
    pageId: string;
    pageUrl: string;
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO notion_tasks (
          turn_id, agent_id, page_id, page_url, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'working', ?, ?)
      `)
      .run(input.turnId, input.agentId, input.pageId, input.pageUrl, now, now);
  }

  listOpenNotionTasksByTurn(turnId: string) {
    return this.db
      .prepare(`
        SELECT id, turn_id, agent_id, page_id, page_url, status
        FROM notion_tasks
        WHERE turn_id = ? AND status = 'working'
        ORDER BY id
      `)
      .all(turnId) as Array<{
        id: number;
        turn_id: string;
        agent_id: string;
        page_id: string;
        page_url: string;
        status: string;
      }>;
  }

  moveOpenNotionTasks(agentId: string, turnId: string) {
    this.db
      .prepare(`
        UPDATE notion_tasks
        SET turn_id = ?, updated_at = ?
        WHERE agent_id = ? AND status = 'working'
      `)
      .run(turnId, new Date().toISOString(), agentId);
  }

  setNotionTaskStatus(id: number, status: "complete" | "failed") {
    this.db
      .prepare(
        "UPDATE notion_tasks SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, new Date().toISOString(), id);
  }

  addDiscordTask(input: {
    turnId: string | null;
    agentId: string;
    channelId: string;
    sourceMessageId?: string;
    userId: string;
    reportToForum?: boolean;
    projectThreadId?: string;
    responseLanguage?: "ko" | "en";
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO discord_tasks (
          turn_id, agent_id, channel_id, source_message_id, user_id, report_to_forum,
          project_thread_id, response_language, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)
      `)
      .run(
        input.turnId,
        input.agentId,
        input.channelId,
        input.sourceMessageId ?? null,
        input.userId,
        input.reportToForum === false ? 0 : 1,
        input.projectThreadId ?? null,
        input.responseLanguage ?? "ko",
        now,
        now,
      );
  }

  listOpenDiscordTasksByTurn(turnId: string) {
    return this.db
      .prepare(`
        SELECT id, turn_id, agent_id, channel_id, source_message_id, user_id,
               report_to_forum, project_thread_id, response_language, status
        FROM discord_tasks
        WHERE turn_id = ? AND status = 'working'
        ORDER BY id
      `)
      .all(turnId) as Array<{
        id: number;
        turn_id: string;
        agent_id: string;
        channel_id: string;
        source_message_id: string | null;
        user_id: string;
        report_to_forum: number;
        project_thread_id: string | null;
        response_language: "ko" | "en";
        status: string;
      }>;
  }

  moveOpenDiscordTasks(agentId: string, turnId: string) {
    this.db
      .prepare(`
        UPDATE discord_tasks
        SET turn_id = ?, updated_at = ?
        WHERE agent_id = ? AND status = 'working'
      `)
      .run(turnId, new Date().toISOString(), agentId);
  }

  setDiscordTaskStatus(id: number, status: "complete" | "failed") {
    this.db
      .prepare(
        "UPDATE discord_tasks SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, new Date().toISOString(), id);
  }

  private mapApproval(row: any): ApprovalRecord {
    return {
      requestId: String(row.request_id),
      createdAt: String(row.created_at),
      agentId: row.agent_id ? String(row.agent_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      method: String(row.method),
      summary: String(row.summary),
      params: parseJson(row.params_json, null),
      status: row.status,
    };
  }
}
