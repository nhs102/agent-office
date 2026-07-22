/* JSON-RPC payloads are versioned by the generated Codex schema. */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type AgentStatus =
  | "offline"
  | "idle"
  | "working"
  | "delegating"
  | "meeting"
  | "waiting"
  | "needs_input"
  | "rate_limited"
  | "error";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  shortRole: string;
  color: string;
  accent: string;
  seat: { x: number; y: number };
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  developerInstructions: string;
  model?: string;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  status: "active" | "paused" | "complete";
  cwd: string;
  ownerAgentId: string;
  description: string;
  notionPageId?: string;
  obsidianPath?: string;
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentRecord extends AgentDefinition {
  threadId: string | null;
  activeTurnId: string | null;
  status: AgentStatus;
  activity: string;
  lastMessage: string;
  lastEventAt: string | null;
  usage: TokenUsage;
}

export interface OfficeEvent {
  id: number;
  createdAt: string;
  type: string;
  agentId: string | null;
  threadId: string | null;
  turnId: string | null;
  summary: string;
  payload: unknown;
}

export interface ApprovalRecord {
  requestId: string;
  createdAt: string;
  agentId: string | null;
  threadId: string | null;
  turnId: string | null;
  method: string;
  summary: string;
  params: unknown;
  status: "pending" | "approved" | "declined" | "cancelled";
}

export interface WorkerRecord {
  threadId: string;
  parentThreadId: string | null;
  parentAgentId: string | null;
  nickname: string;
  role: string;
  status: "working" | "waiting" | "completed" | "failed";
  activity: string;
  spawnedAt: string;
  updatedAt: string;
}

export interface AgentMovement {
  agentId: string;
  destination: "whiteboard" | "agent" | "seat";
  targetAgentId: string | null;
  label: string;
  startedAt: string;
  endsAt: string;
}

export interface CodexAccountState {
  connected: boolean;
  authMode: "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";
  email: string | null;
  planType: string | null;
  userAgent: string | null;
  rateLimits: unknown;
  error: string | null;
}

export interface NotionConnectionState {
  configured: boolean;
  connected: boolean;
  databaseUrl: string | null;
  error: string | null;
}

export interface DiscordConnectionState {
  configured: boolean;
  connected: boolean;
  botName: string | null;
  error: string | null;
  voice: {
    configured: boolean;
    connected: boolean;
    mode: "idle" | "dump" | "interview";
    transcribing: boolean;
    bufferedSegments: number;
    error: string | null;
  };
}

export interface OfficeState {
  generatedAt: string;
  officeStatus: "connected" | "starting" | "disconnected" | "error";
  account: CodexAccountState;
  notion: NotionConnectionState;
  discord: DiscordConnectionState;
  agents: AgentRecord[];
  movements: AgentMovement[];
  workers: WorkerRecord[];
  projects: ProjectDefinition[];
  events: OfficeEvent[];
  approvals: ApprovalRecord[];
  threadCount: number;
}

export interface RpcEnvelope {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}
