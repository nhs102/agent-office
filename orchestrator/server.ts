/* Codex notification item variants are normalized before entering app state. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { CodexAppServerClient } from "./codex-client";
import { loadConfiguration, projectRoot } from "./config";
import { OfficeDatabase } from "./db";
import { DiscordBot, type DiscordCommandInput } from "./discord";
import {
  isDiscordVerificationCommand,
  normalizeDiscordProgressText,
} from "./discord-progress";
import { shouldReportDiscordWork } from "./discord-reporting";
import {
  detectOfficeLanguage,
  officeLanguageInstruction,
  officeLanguageText,
  type OfficeLanguage,
} from "./language";
import { NotionSync, type NotionDatabaseReference } from "./notion";
import type {
  AgentMovement,
  AgentRecord,
  AgentStatus,
  CodexAccountState,
  OfficeState,
  RpcEnvelope,
  TokenUsage,
  WorkerRecord,
} from "./types";

try {
  process.loadEnvFile(path.join(projectRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const PORT = Number(process.env.AGENT_OFFICE_PORT ?? 8788);
const HOST = process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";
const database = new OfficeDatabase(
  process.env.AGENT_OFFICE_DB ?? path.join(projectRoot, "data/agent-office.db"),
);
const codex = new CodexAppServerClient();
const notion = new NotionSync(process.env.NOTION_API_KEY);
const sseClients = new Set<ServerResponse>();
const pendingServerRequests = new Map<string, RpcEnvelope>();
const agentMovements = new Map<string, AgentMovement>();
const movementTimers = new Map<string, NodeJS.Timeout>();
const relayRoutes = new Map<
  string,
  { sourceAgentId: string; targetAgentId: string }
>();
const inFlightHandoffs = new Map<string, { targetAgentId: string }>();
const pendingUpstreamRoutes = new Map<
  string,
  { sourceAgentId: string; targetAgentId: string }
>();
const processedFinalTurns = new Set<string>();
type DiscordProgressRoute = {
  channelId: string;
  language: OfficeLanguage;
};
const discordProgressRoutes = new Map<string, DiscordProgressRoute[]>();
const deliveredDiscordProgress = new Set<string>();
interface DiscordDiscussion {
  id: string;
  channelId: string;
  messageId: string | null;
  command: string;
  participantIds: string[];
  index: number;
  language: OfficeLanguage;
}
const discordDiscussions = new Map<string, DiscordDiscussion>();
const discussionTurnRoutes = new Map<
  string,
  { discussionId: string; agentId: string }
>();

function discordProgressRoutesForTurn(turnId: string) {
  const routes = [
    ...database.listOpenDiscordTasksByTurn(turnId).map((task) => ({
      channelId: task.channel_id,
      language: task.response_language,
    })),
    ...(discordProgressRoutes.get(turnId) ?? []),
  ];
  return routes.filter(
    (route, index) =>
      routes.findIndex((candidate) => candidate.channelId === route.channelId) === index,
  );
}

function discordLanguageForTurn(turnId: string | null | undefined) {
  if (!turnId) return "ko" as const;
  return discordProgressRoutesForTurn(String(turnId))[0]?.language ?? "ko";
}

function clearDiscordProgress(turnId: string) {
  discordProgressRoutes.delete(turnId);
  const prefix = `${turnId}:`;
  for (const key of deliveredDiscordProgress) {
    if (key.startsWith(prefix)) deliveredDiscordProgress.delete(key);
  }
}

async function sendDiscordProgress(
  agent: AgentRecord,
  turnId: string | null | undefined,
  label: string,
  text: string,
  icon = "📍",
) {
  if (!turnId) return;
  const clean = normalizeDiscordProgressText(text);
  if (!clean) return;
  const routes = discordProgressRoutesForTurn(String(turnId));
  for (const route of routes) {
    const signature = `${turnId}:${route.channelId}:${agent.id}:${label}:${clean}`;
    if (deliveredDiscordProgress.has(signature)) continue;
    deliveredDiscordProgress.add(signature);
    try {
      await discord.sendProgressUpdate(
        route.channelId,
        agent.id,
        agent.shortRole,
        label,
        clean,
        icon,
      );
      addEvent(
        "discord.progress_sent",
        `${agent.name} 디스코드 진행 보고`,
        { channelId: route.channelId, label, text: clean },
        agent,
        agent.threadId,
        String(turnId),
      );
    } catch (error) {
      deliveredDiscordProgress.delete(signature);
      addEvent(
        "discord.progress_failed",
        "디스코드 진행 상황 전송 실패",
        { error: error instanceof Error ? error.message : String(error) },
        agent,
        agent.threadId,
        String(turnId),
      );
    }
  }
}

let officeStatus: OfficeState["officeStatus"] = "starting";
let threadCount = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let account: CodexAccountState = {
  connected: false,
  authMode: "unknown",
  email: null,
  planType: null,
  userAgent: null,
  rateLimits: null,
  error: null,
};

const configuration = await loadConfiguration();
const discord = new DiscordBot(
  {
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    channelId: process.env.DISCORD_CHANNEL_ID,
    reportForumId: process.env.DISCORD_REPORT_FORUM_ID,
    allowedUserId: process.env.DISCORD_ALLOWED_USER_ID,
    messageContentEnabled:
      process.env.DISCORD_MESSAGE_CONTENT_ENABLED === "true",
    voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID,
    voiceTextChannelId: process.env.DISCORD_VOICE_TEXT_CHANNEL_ID,
    voicePythonPath:
      process.env.VOICE_PYTHON_PATH ??
      path.join(projectRoot, ".agent-office/voice-venv/bin/python"),
    voiceTranscriberScript: path.join(
      projectRoot,
      "scripts/voice-transcriber.py",
    ),
    voiceWhisperModel:
      process.env.VOICE_WHISPER_MODEL ??
      "mlx-community/whisper-small-mlx",
    agents: configuration.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      shortRole: agent.shortRole,
    })),
    directMessageBots: configuration.agents
      .filter((agent) => agent.id !== "chief")
      .map((agent) => ({
        agentId: agent.id,
        shortRole: agent.shortRole,
        token: process.env[`DISCORD_${agent.shortRole}_BOT_TOKEN`],
        applicationId:
          process.env[`DISCORD_${agent.shortRole}_APPLICATION_ID`],
      })),
  },
  handleDiscordCommand,
  () => broadcast(),
);
const officeDynamicTools = [
  {
    namespace: "agent_office",
    name: "send_agent_message",
    description:
      "Send a concrete task, question, or result to another standing Agent Office role. Use the configured role id as target.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: configuration.agents.map((agent) => agent.id),
          description: "Standing Agent Office role id",
        },
        message: {
          type: "string",
          minLength: 1,
          description: "The exact task, question, or result to deliver",
        },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
  },
];
database.seedAgents(configuration.agents);
database.seedProjects(configuration.projects);
for (const agent of configuration.agents) {
  const modelOverride = database.getSetting<string | null>(
    `agent.model.${agent.id}`,
    null,
  );
  if (modelOverride) database.setAgentModel(agent.id, modelOverride);
}
database.setAllDisconnected();
database.cancelPendingApprovals();

function broadcast(type = "refresh", payload: unknown = null) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    if (client.writableEnded || client.destroyed) {
      sseClients.delete(client);
      continue;
    }
    client.write(frame);
  }
}

function addEvent(
  type: string,
  summary: string,
  payload: unknown,
  agent: AgentRecord | null = null,
  threadId: string | null = agent?.threadId ?? null,
  turnId: string | null = agent?.activeTurnId ?? null,
) {
  const event = database.addEvent({
    type,
    agentId: agent?.id ?? null,
    threadId,
    turnId,
    summary,
    payload,
  });
  broadcast("office-event", event);
  return event;
}

function getOfficeState(): OfficeState {
  return {
    generatedAt: new Date().toISOString(),
    officeStatus,
    account,
    notion: notion.getState(),
    discord: discord.getState(),
    agents: database.listAgents(),
    movements: [...agentMovements.values()],
    workers: database.listWorkers(),
    projects: configuration.projects,
    events: database.listEvents(120),
    approvals: database.listPendingApprovals(),
    threadCount,
  };
}

async function initializeNotion() {
  const saved = database.getSetting<NotionDatabaseReference | null>(
    "notion.database",
    null,
  );
  const reference = await notion.initialize(saved);
  if (reference) {
    database.setSetting("notion.database", reference);
    addEvent(
      "notion.connected",
      "노션 업무 보드 연결됨",
      { databaseUrl: reference.databaseUrl },
    );
  } else if (notion.getState().configured) {
    addEvent(
      "notion.connection_failed",
      "노션 업무 보드 연결 실패",
      { error: notion.getState().error },
    );
  }
  broadcast();
  return reference;
}

async function createNotionTask(
  agent: AgentRecord,
  text: string,
  result: { threadId: string | null; turnId: string | null },
) {
  if (!notion.getState().configured) return null;
  if (!notion.getState().connected) await initializeNotion();
  try {
    const task = await notion.createTask({
      title: `${agent.shortRole} · ${safeText(text.replace(/@\S+\s*/, ""), 110) || "화이트보드 업무"}`,
      request: text,
      agentId: agent.id,
      threadId: result.threadId,
      turnId: result.turnId,
      startedAt: new Date().toISOString(),
    });
    if (!task) return null;
    database.addNotionTask({
      turnId: result.turnId,
      agentId: agent.id,
      pageId: task.pageId,
      pageUrl: task.pageUrl,
    });
    addEvent(
      "notion.task_created",
      `${agent.name} 업무를 노션에 기록`,
      { pageUrl: task.pageUrl },
      agent,
      result.threadId,
      result.turnId,
    );
    return task;
  } catch (error) {
    addEvent(
      "notion.sync_failed",
      "노션 업무 기록 실패",
      { error: error instanceof Error ? error.message : String(error) },
      agent,
      result.threadId,
      result.turnId,
    );
    return null;
  }
}

async function finishNotionTasks(
  agent: AgentRecord,
  turnId: string,
  status: "완료" | "실패",
  result: string,
) {
  const tasks = database.listOpenNotionTasksByTurn(turnId);
  for (const task of tasks) {
    try {
      await notion.completeTask(task.page_id, status, result);
      database.setNotionTaskStatus(
        task.id,
        status === "완료" ? "complete" : "failed",
      );
      addEvent(
        "notion.task_updated",
        `${agent.name} 노션 업무 ${status}`,
        { pageUrl: task.page_url, status },
        agent,
        agent.threadId,
        turnId,
      );
    } catch (error) {
      addEvent(
        "notion.sync_failed",
        "노션 완료 기록 실패",
        {
          pageUrl: task.page_url,
          error: error instanceof Error ? error.message : String(error),
        },
        agent,
        agent.threadId,
        turnId,
      );
    }
  }
  if (tasks.length) broadcast();
}

async function finishDiscordTasks(
  agent: AgentRecord,
  turnId: string,
  status: "complete" | "failed",
  result: string,
) {
  const tasks = database.listOpenDiscordTasksByTurn(turnId);
  for (const task of tasks) {
    try {
      await discord.sendResult(
        task.channel_id,
        agent.id,
        agent.shortRole,
        status,
        result,
        task.response_language,
      );
      await discord.reactToMessage(
        task.channel_id,
        task.source_message_id,
        agent.id,
        status === "complete" ? "✅" : "⚠️",
      );
      database.setDiscordTaskStatus(task.id, status);
      addEvent(
        "discord.task_updated",
        `${agent.name} 디스코드 결과 전송`,
        { status },
        agent,
        agent.threadId,
        turnId,
      );
      if (task.project_thread_id) {
        try {
          await discord.finishProjectThread(task.project_thread_id, status);
          addEvent(
            "discord.project_status_updated",
            `${agent.name} 프로젝트 포럼 ${status}`,
            { projectThreadId: task.project_thread_id, status },
            agent,
            agent.threadId,
            turnId,
          );
        } catch (error) {
          addEvent(
            "discord.project_status_failed",
            "프로젝트 포럼 상태 변경 실패",
            { error: error instanceof Error ? error.message : String(error) },
            agent,
            agent.threadId,
            turnId,
          );
        }
      }
    } catch (error) {
      database.setDiscordTaskStatus(task.id, "failed");
      addEvent(
        "discord.sync_failed",
        "디스코드 결과 전송 실패",
        { error: error instanceof Error ? error.message : String(error) },
        agent,
        agent.threadId,
        turnId,
      );
    }
  }
  if (tasks.some((task) => Boolean(task.report_to_forum))) {
    try {
      const report = await discord.sendReport(
        agent.id,
        agent.shortRole,
        status,
        result,
      );
      if (report) {
        addEvent(
          "discord.report_posted",
          `${agent.name} 토론방 결과 보고`,
          { status, reportUrl: report.url },
          agent,
          agent.threadId,
          turnId,
        );
      }
    } catch (error) {
      addEvent(
        "discord.report_failed",
        "디스코드 토론방 결과 보고 실패",
        { error: error instanceof Error ? error.message : String(error) },
        agent,
        agent.threadId,
        turnId,
      );
    }
  }
  clearDiscordProgress(turnId);
  if (tasks.length) broadcast();
}

function safeText(value: unknown, max = 180) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function moveAgent(
  agentId: string,
  destination: AgentMovement["destination"],
  targetAgentId: string | null,
  label: string,
  durationMs = 5_500,
  onComplete?: () => void,
) {
  const previousTimer = movementTimers.get(agentId);
  if (previousTimer) clearTimeout(previousTimer);
  const startedAt = new Date();
  const movement: AgentMovement = {
    agentId,
    destination,
    targetAgentId,
    label: safeText(label, 80),
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + durationMs).toISOString(),
  };
  agentMovements.set(agentId, movement);
  broadcast("movement", movement);
  const timer = setTimeout(() => {
    movementTimers.delete(agentId);
    if (onComplete) {
      onComplete();
      return;
    }
    agentMovements.delete(agentId);
    broadcast("movement", { agentId, returned: true });
  }, durationMs);
  movementTimers.set(agentId, timer);
  return movement;
}

function visitWhiteboard(agentId: string, label: string) {
  return moveAgent(agentId, "whiteboard", null, label, 2_500, () => {
    moveAgent(agentId, "seat", null, "자리로 돌아가는 중", 1_800);
  });
}

function normalizeAgentReference(value: string) {
  return value
    .replace(/^@/, "")
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, "");
}

function resolveAgentReference(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = normalizeAgentReference(value);
  const aliases: Record<string, string> = {
    비서: "chief",
    메인비서: "chief",
    총괄: "chief",
    프로젝트매니저: "pm",
    엔지니어: "engineer",
    시스템엔지니어: "engineer",
    재무: "finance",
    재무관리자: "finance",
    파견: "dispatch",
    파견관리자: "dispatch",
    리서치: "research",
    리서처: "research",
    조사: "research",
    디자이너: "design",
    제품디자이너: "design",
    디자인: "design",
    검증: "qa",
    검증관: "qa",
    품질검증: "qa",
  };
  const aliasedId = aliases[normalized];
  return (
    configuration.agents.find(
      (agent) =>
        normalizeAgentReference(agent.id) === normalized ||
        normalizeAgentReference(agent.shortRole) === normalized ||
        normalizeAgentReference(agent.name) === normalized ||
        agent.id === aliasedId,
    ) ?? null
  );
}

function mentionedAgents(text: string) {
  const matches = text.matchAll(
    /@(CHIEF|PM|ENGINEER|FINANCE|DISPATCH|RESEARCH|DESIGN|QA|메인비서|비서|총괄|프로젝트매니저|시스템엔지니어|엔지니어|재무관리자|재무|파견관리자|파견|리서치|리서처|조사|제품디자이너|디자이너|디자인|품질검증|검증관|검증)(?![A-Za-z0-9가-힣_-])/gi,
  );
  const ids = new Set<string>();
  for (const match of matches) {
    const agent = resolveAgentReference(match[1]);
    if (agent) ids.add(agent.id);
  }
  return configuration.agents.filter((agent) => ids.has(agent.id));
}

function officeDeveloperInstructions(agent: AgentRecord) {
  const roles = configuration.agents
    .map((item) => `${item.id}=${item.name}`)
    .join(", ");
  return `${agent.developerInstructions}\n\nAgent Office 사용자 보고 규칙:\n- 반드시 사용자의 최신 요청과 같은 언어로 답하세요. 영어 요청이면 모든 진행 보고와 최종 답변을 자연스러운 영어로 작성하고 한국어 호칭이나 문장을 섞지 마세요. 한국어 요청일 때만 친한 동료와 대화하듯 자연스러운 존댓말을 쓰고 사용자를 '대표님'이라고 호칭하세요. 매번 같은 인사로 시작하거나 보고서·회의록처럼 말하지 마세요.\n- 화면에 바로 보일 답은 반드시 <office_summary>...</office_summary> 안에 한두 문장, 가능하면 120자 안팎으로 작성하세요. 무엇을 완료했는지와 꼭 알아야 할 내용만 자연스럽게 말하세요.\n- office_summary에는 굵은 글씨, 백틱, 제목, 목록, '결론:', '요약:', '완료:', '추천:' 같은 보고서 표식을 절대 쓰지 마세요. 역할별 근거 나열, 긴 설명, 체크리스트도 넣지 마세요.\n- 근거, 수행 내역, 확인 방법처럼 사용자가 원할 때만 볼 내용은 <office_details>...</office_details>에 작성하세요. 시스템이 이를 접힌 상세 기록으로 따로 보관합니다. 세부 내용이 없으면 이 태그는 생략해도 됩니다.\n\nAgent Office 내부 전달 규칙:\n- 다른 상주 에이전트의 전문 업무가 필요하면 agent_office.send_agent_message 도구가 보일 때 그 도구를 사용하세요. 유효한 대상은 ${roles} 입니다.\n- 한 번에는 반드시 딱 한 명에게만 전달하세요. 같은 응답에서 도구를 여러 번 호출하거나 여러 전달 블록을 만들지 마세요.\n- 먼저 전달한 에이전트의 결과가 돌아오기 전에는 다음 에이전트에게 전달하지 마세요. 결과를 확인한 뒤에만 필요하면 다음 한 명을 선택해 이어서 전달하세요. 병렬 전달과 동시 수집은 금지됩니다.\n- 도구가 보이지 않는 기존 세션에서는 최종 응답 끝에 <agent_handoff target="대상 id">전달할 구체적인 업무</agent_handoff> 블록을 정확히 하나만 사용하세요. 시스템이 실제 대상 스레드로 전달하고 이 블록은 사용자 말풍선에서 숨깁니다.\n- 전달하지 않았다면 전달했다고 주장하지 마세요. 자신에게 전달하지 말고, 불필요한 왕복 전달을 만들지 마세요.\n- [AGENT OFFICE 내부 전달]로 받은 요청에는 보고 태그나 인사를 사용하지 말고 결과와 검증 근거를 구체적으로 답하세요. 시스템이 요청한 에이전트에게 결과를 돌려줍니다.`;
}

function extractAgentHandoffs(text: string) {
  const handoffs: Array<{ target: string; message: string }> = [];
  const pattern =
    /<agent_handoff\s+target=["']([^"']+)["']\s*>([\s\S]*?)<\/agent_handoff>/gi;
  for (const match of text.matchAll(pattern)) {
    const message = match[2].trim();
    if (message) handoffs.push({ target: match[1].trim(), message });
  }
  return handoffs;
}

function stripAgentHandoffs(text: string) {
  return text
    .replace(
      /<agent_handoff\s+target=["'][^"']+["']\s*>[\s\S]*?<\/agent_handoff>/gi,
      "",
    )
    .trim();
}

function compactAgentSummary(text: string) {
  const clean = text
    .trim()
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(
      /^\s*(?:(?:결론|요약|완료(?:\s*보고)?|결과|추천|한\s*줄\s*요약)\s*[:：-]\s*)+/i,
      "",
    )
    .trim();
  if (!clean) return "";
  const firstParagraph = clean
    .split(/\n\s*\n/, 1)[0]
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = firstParagraph.match(/[^.!?]+[.!?]+(?:["'’”)]*)/g);
  const candidate =
    sentences?.slice(0, 2).map((sentence) => sentence.trim()).join(" ") ||
    firstParagraph;
  if (candidate.length <= 160) return candidate;
  return `${candidate.slice(0, 157).trimEnd()}…`;
}

function parseAgentReport(text: string) {
  const clean = stripAgentHandoffs(text);
  const explicitSummary = clean
    .match(/<office_summary>([\s\S]*?)<\/office_summary>/i)?.[1]
    ?.trim();
  const explicitDetails = [...clean.matchAll(/<office_details>([\s\S]*?)<\/office_details>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join("\n\n");
  const withoutReportTags = explicitSummary
    ? clean
        .replace(/<office_summary>[\s\S]*?<\/office_summary>/gi, "")
        .replace(/<office_details>[\s\S]*?<\/office_details>/gi, "")
        .trim()
    : "";
  const rawSummary = explicitSummary || clean;
  const summary = compactAgentSummary(rawSummary);
  const fallbackDetails = !explicitSummary && clean !== summary ? clean : "";
  const details = [explicitDetails, withoutReportTags, fallbackDetails]
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .join("\n\n");
  return {
    summary:
      summary ||
      (extractAgentHandoffs(text).length ? "담당자에게 전달했어요. 끝나면 바로 알려드릴게요." : ""),
    details,
  };
}

function visibleAgentMessage(text: string) {
  return parseAgentReport(text).summary;
}

async function dispatchAgentHandoff(
  source: AgentRecord,
  targetReference: unknown,
  message: string,
  responseLanguage: OfficeLanguage = detectOfficeLanguage(message),
) {
  const targetDefinition = resolveAgentReference(targetReference);
  const target = targetDefinition
    ? database.getAgent(targetDefinition.id)
    : null;
  if (!target) throw new Error(`알 수 없는 전달 대상입니다: ${String(targetReference)}`);
  if (target.id === source.id) throw new Error("자기 자신에게는 업무를 전달할 수 없습니다");
  const existingHandoff = inFlightHandoffs.get(source.id);
  if (existingHandoff) {
    const existingTarget = database.getAgent(existingHandoff.targetAgentId);
    throw new Error(
      `${existingTarget?.name ?? "이전 에이전트"}의 결과를 기다리는 중입니다. 결과가 돌아온 뒤 다음 업무를 전달하세요.`,
    );
  }
  inFlightHandoffs.set(source.id, { targetAgentId: target.id });

  try {
    moveAgent(
      source.id,
      "agent",
      target.id,
      `${target.shortRole}에게 전달 중`,
    );
    addEvent(
      "agent.handoff",
      `${source.name} → ${target.name} 업무 전달`,
      { sourceAgentId: source.id, targetAgentId: target.id, message },
      source,
    );
    const result = await sendAgentMessage(
      target.id,
      `[AGENT OFFICE 내부 전달]\n보낸 사람: ${source.name} (${source.shortRole})\n\n${message}\n\n${officeLanguageInstruction(responseLanguage)}\n\n요청한 에이전트에게 돌려줄 수 있도록 결과를 구체적으로 답하세요.`,
      { direction: "system", sourceAgentId: source.id },
    );
    if (!result.turnId) throw new Error("전달 대상의 작업이 시작되지 않았습니다");
    relayRoutes.set(String(result.turnId), {
      sourceAgentId: source.id,
      targetAgentId: target.id,
    });
    return { target, result };
  } catch (error) {
    inFlightHandoffs.delete(source.id);
    throw error;
  }
}

async function processAgentHandoffs(
  source: AgentRecord,
  text: string,
  turnId: string | null,
) {
  const handoffs = extractAgentHandoffs(text);
  const handoff = handoffs[0];
  if (!handoff) return;
  if (handoffs.length > 1) {
    addEvent(
      "agent.handoff_serialized",
      `${source.name}의 복수 전달을 첫 번째 대상만 처리`,
      { requested: handoffs.length, selectedTarget: handoff.target },
      source,
    );
  }
  try {
    const routes = turnId
      ? discordProgressRoutesForTurn(String(turnId))
      : [];
    const responseLanguage =
      routes[0]?.language ?? detectOfficeLanguage(handoff.message);
    const { target, result } = await dispatchAgentHandoff(
      source,
      handoff.target,
      handoff.message,
      responseLanguage,
    );
    if (turnId) {
      if (result.turnId && routes.length) {
        discordProgressRoutes.set(String(result.turnId), routes);
      }
      for (const route of routes) {
        await discord
          .sendHandoffUpdate(
            route.channelId,
            target.id,
            source.shortRole,
            target.shortRole,
          )
          .catch((error) => {
            addEvent(
              "discord.progress_failed",
              "디스코드 업무 진행 상태 전송 실패",
              { error: error instanceof Error ? error.message : String(error) },
              source,
              source.threadId,
              turnId,
            );
          });
      }
    }
  } catch (error) {
    addEvent(
      "agent.handoff_failed",
      `${source.name} 업무 전달 실패`,
      {
        target: handoff.target,
        error: error instanceof Error ? error.message : String(error),
      },
      source,
    );
  }
}

async function returnAgentResult(
  route: { sourceAgentId: string; targetAgentId: string },
  resultText: string,
  completedTurnId?: string,
) {
  const source = database.getAgent(route.sourceAgentId);
  const target = database.getAgent(route.targetAgentId);
  if (!source || !target || !resultText) return;
  const completedRoutes = completedTurnId
    ? discordProgressRoutesForTurn(completedTurnId)
    : [];
  const responseLanguage =
    completedRoutes[0]?.language ?? detectOfficeLanguage(resultText);
  if (completedTurnId) clearDiscordProgress(completedTurnId);
  moveAgent(
    source.id,
    "agent",
    target.id,
    `${target.shortRole} 자리에서 결과 확인 중`,
    4_500,
  );
  addEvent(
    "agent.result_returned",
    `${target.name} → ${source.name} 결과 전달`,
    { sourceAgentId: target.id, targetAgentId: source.id, message: resultText },
    target,
  );
  inFlightHandoffs.delete(source.id);
  const returned = await sendAgentMessage(
    source.id,
    `[AGENT OFFICE 내부 결과]\n${target.name} (${target.shortRole})의 답변:\n\n${resultText}\n\n${officeLanguageInstruction(responseLanguage)}\n\n이 결과를 반영해 사용자에게 필요한 결론이나 다음 행동을 정리하세요.`,
    { direction: "system", sourceAgentId: target.id },
  );
  if (returned.turnId) {
    database.moveOpenNotionTasks(source.id, String(returned.turnId));
    database.moveOpenDiscordTasks(source.id, String(returned.turnId));
  }
  const upstreamRoute = pendingUpstreamRoutes.get(source.id);
  if (upstreamRoute && returned.turnId) {
    pendingUpstreamRoutes.delete(source.id);
    relayRoutes.set(String(returned.turnId), upstreamRoute);
  }
}

function handleFinalAgentMessage(
  agent: AgentRecord,
  text: string,
  threadId: string | null,
  turnId: string | null,
) {
  const report = parseAgentReport(text);
  const visibleMessage = report.summary;
  if (visibleMessage) {
    database.setAgentMessage(agent.id, visibleMessage);
  }

  const finalKey = turnId ? `${agent.id}:${turnId}` : null;
  if (finalKey && processedFinalTurns.has(finalKey)) return visibleMessage;
  if (finalKey) processedFinalTurns.add(finalKey);

  if (visibleMessage) {
    database.addMessage(agent.id, "agent", visibleMessage, threadId, turnId);
  }
  const discussionRoute = turnId
    ? discussionTurnRoutes.get(String(turnId))
    : undefined;
  if (discussionRoute && turnId) {
    discussionTurnRoutes.delete(String(turnId));
    void completeDiscordDiscussionTurn(discussionRoute, text);
    return visibleMessage;
  }
  if (report.details) {
    addEvent(
      "agent.report_detail",
      `${agent.name} 상세 기록 저장`,
      { text: report.details },
      agent,
      threadId,
      turnId,
    );
  }
  const handoffs = extractAgentHandoffs(text);
  const relayRoute = turnId ? relayRoutes.get(String(turnId)) : undefined;
  if (relayRoute) {
    relayRoutes.delete(String(turnId));
    if (handoffs.length) {
      pendingUpstreamRoutes.set(agent.id, relayRoute);
    } else {
      const relayResult = report.details
        ? `${visibleMessage}\n\n상세 결과:\n${report.details}`
        : visibleMessage;
      void returnAgentResult(relayRoute, relayResult, turnId ?? undefined);
    }
  }
  if (handoffs.length) {
    void processAgentHandoffs(agent, text, turnId);
  } else if (turnId) {
    const result = report.details
      ? `${visibleMessage}\n\n${report.details}`
      : visibleMessage;
    void finishNotionTasks(agent, String(turnId), "완료", result);
    void finishDiscordTasks(agent, String(turnId), "complete", result);
  }
  return visibleMessage;
}

function itemSummary(item: any, stage: "started" | "completed") {
  const prefix = stage === "started" ? "시작" : "완료";
  switch (item?.type) {
    case "agentMessage":
      return safeText(item.text) || `응답 ${prefix}`;
    case "commandExecution":
      return `명령 ${prefix}: ${safeText(item.command, 120)}`;
    case "fileChange":
      return `파일 변경 ${prefix} · ${item.changes?.length ?? 0}개`;
    case "mcpToolCall":
      return `도구 ${prefix}: ${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return `도구 ${prefix}: ${item.tool}`;
    case "webSearch":
      return `검색 ${prefix}: ${safeText(item.query, 100)}`;
    case "collabAgentToolCall": {
      const labels: Record<string, string> = {
        spawnAgent: "워커 소환",
        sendInput: "워커에게 업무 전달",
        resumeAgent: "워커 재개",
        wait: "워커 결과 대기",
        closeAgent: "워커 종료",
      };
      return `${labels[item.tool] ?? "에이전트 협업"} ${prefix}`;
    }
    case "reasoning":
      return `검토 ${prefix}`;
    case "plan":
      return `계획 ${prefix}`;
    default:
      return `${item?.type ?? "작업"} ${prefix}`;
  }
}

function statusFromThreadStatus(status: any): AgentStatus {
  if (status?.type === "systemError") return "error";
  if (status?.type === "idle" || status?.type === "notLoaded") return "idle";
  if (status?.type === "active") {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (
      flags.includes("waitingOnApproval") ||
      flags.includes("waitingOnUserInput")
    ) {
      return "needs_input";
    }
    return "working";
  }
  return "working";
}

function mapWorkerStatus(value: string | undefined): WorkerRecord["status"] {
  if (value === "completed" || value === "shutdown") return "completed";
  if (value === "errored" || value === "notFound") return "failed";
  if (value === "interrupted") return "waiting";
  return "working";
}

function upsertWorkerFromThread(thread: any) {
  const source = thread?.source?.subAgent;
  const spawn = source?.thread_spawn;
  if (!spawn || !thread?.id) return;
  const parent = database.findAgentByThread(spawn.parent_thread_id);
  const existing = database
    .listWorkers()
    .find((worker) => worker.threadId === thread.id);
  const now = new Date().toISOString();
  database.upsertWorker({
    threadId: thread.id,
    parentThreadId: spawn.parent_thread_id ?? null,
    parentAgentId: parent?.id ?? null,
    nickname:
      thread.agentNickname ?? spawn.agent_nickname ?? existing?.nickname ?? "Worker",
    role: thread.agentRole ?? spawn.agent_role ?? existing?.role ?? "worker",
    status: thread.status?.type === "systemError" ? "failed" : "working",
    activity: thread.preview || existing?.activity || "파견 업무 수행 중",
    spawnedAt: existing?.spawnedAt ?? now,
    updatedAt: now,
  });
}

function upsertPlaceholderWorkers(item: any, parent: AgentRecord | null) {
  if (item?.type !== "collabAgentToolCall") return;
  const now = new Date().toISOString();
  const stateEntries = Object.entries(item.agentsStates ?? {}) as Array<
    [string, any]
  >;
  const ids = new Set<string>([
    ...(item.receiverThreadIds ?? []),
    ...stateEntries.map(([threadId]) => threadId),
  ]);

  for (const threadId of ids) {
    const existing = database
      .listWorkers()
      .find((worker) => worker.threadId === threadId);
    const state = (item.agentsStates ?? {})[threadId];
    database.upsertWorker({
      threadId,
      parentThreadId: item.senderThreadId ?? parent?.threadId ?? null,
      parentAgentId: parent?.id ?? existing?.parentAgentId ?? null,
      nickname: existing?.nickname ?? `Worker ${threadId.slice(-4)}`,
      role: existing?.role ?? "subagent",
      status:
        item.tool === "closeAgent"
          ? "completed"
          : mapWorkerStatus(state?.status),
      activity:
        safeText(state?.message) ||
        safeText(item.prompt) ||
        (item.tool === "wait" ? "결과 정리 중" : "파견 업무 수행 중"),
      spawnedAt: existing?.spawnedAt ?? now,
      updatedAt: now,
    });
  }
}

function handleNotification(message: RpcEnvelope) {
  const method = message.method ?? "unknown";
  const params = message.params ?? {};
  const threadId = params.threadId ?? params.thread?.id ?? null;
  const turnId = params.turnId ?? params.turn?.id ?? null;
  const agent = database.findAgentByThread(threadId);

  if (method === "thread/started") {
    upsertWorkerFromThread(params.thread);
  }

  if (method === "thread/status/changed" && agent) {
    const status = statusFromThreadStatus(params.status);
    const activity =
      status === "needs_input"
        ? "사용자 확인을 기다리는 중"
        : status === "working"
          ? "Codex가 작업 중"
          : status === "error"
            ? "시스템 오류"
            : "다음 업무 대기 중";
    database.setAgentRuntime(agent.id, status, activity);
  }

  if (method === "turn/started" && agent) {
    database.setAgentRuntime(agent.id, "working", "요청을 분석하는 중", turnId);
    addEvent(method, `${agent.name} 작업 시작`, params, agent, threadId, turnId);
  }

  if (method === "turn/completed" && agent) {
    const turn = params.turn ?? {};
    const failed = turn.status === "failed";
    const interrupted = turn.status === "interrupted";
    const finalMessage = [...(turn.items ?? [])]
      .reverse()
      .find((item: any) => item.type === "agentMessage")?.text;
    if (finalMessage) {
      handleFinalAgentMessage(agent, finalMessage, threadId, turnId);
    }
    if (!finalMessage && turnId) {
      const completedTurnId = String(turnId);
      setTimeout(() => {
        if (processedFinalTurns.has(`${agent.id}:${completedTurnId}`)) return;
        const discussionRoute = discussionTurnRoutes.get(completedTurnId);
        if (discussionRoute) {
          discussionTurnRoutes.delete(completedTurnId);
          processedFinalTurns.add(`${agent.id}:${completedTurnId}`);
          const reason = failed
            ? safeText(turn.error?.message) || "작업 실패"
            : interrupted
              ? "작업이 중단됨"
              : "응답 없이 종료됨";
          void completeDiscordDiscussionTurn(discussionRoute, reason, true);
          return;
        }
        const stalledRoute = relayRoutes.get(completedTurnId);
        if (stalledRoute) {
          relayRoutes.delete(completedTurnId);
          void returnAgentResult(
            stalledRoute,
            failed
              ? `전달된 업무가 실패했습니다: ${safeText(turn.error?.message) || "원인 미상"}`
              : "전달된 업무가 응답 없이 종료되었습니다.",
            completedTurnId,
          );
        }
        void finishNotionTasks(
          agent,
          completedTurnId,
          "실패",
          failed
            ? safeText(turn.error?.message) || "작업이 실패했습니다"
            : interrupted
              ? "작업이 중단됐습니다"
              : "응답 없이 종료됐습니다",
        );
        void finishDiscordTasks(
          agent,
          completedTurnId,
          "failed",
          failed
            ? safeText(turn.error?.message) || "작업이 실패했어요."
            : interrupted
              ? "작업이 중단됐어요."
              : "응답 없이 종료됐어요.",
        );
      }, 750);
    }
    database.setAgentRuntime(
      agent.id,
      failed ? "error" : "idle",
      failed
        ? safeText(turn.error?.message) || "작업 실패"
        : interrupted
          ? "작업이 중단됨"
          : "업무 완료 · 대기 중",
      null,
    );
    addEvent(
      method,
      `${agent.name} ${failed ? "작업 실패" : "작업 완료"}`,
      params,
      agent,
      threadId,
      turnId,
    );
  }

  if (method === "turn/plan/updated" && agent) {
    const current = (params.plan ?? []).find(
      (step: any) => step.status === "inProgress",
    );
    database.setAgentRuntime(
      agent.id,
      "working",
      current?.step ? safeText(current.step) : "작업 계획 갱신",
    );
    if (turnId && current?.step) {
      void sendDiscordProgress(
        agent,
        String(turnId),
        "PLAN",
        safeText(current.step, 1_200),
        "🧭",
      );
    }
  }

  if (method === "item/started" || method === "item/completed") {
    const stage = method.endsWith("started") ? "started" : "completed";
    const item = params.item;
    upsertPlaceholderWorkers(item, agent);
    if (agent) {
      let status: AgentStatus = "working";
      if (item?.type === "collabAgentToolCall") {
        status = item.tool === "wait" ? "waiting" : "delegating";
      }
      const summary = itemSummary(item, stage);
      database.setAgentRuntime(agent.id, status, summary, turnId);
      if (stage === "completed" && turnId && item?.type === "fileChange") {
        const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
        const responseLanguage = discordLanguageForTurn(String(turnId));
        void sendDiscordProgress(
          agent,
          String(turnId),
          "IMPLEMENTING",
          officeLanguageText(
            responseLanguage,
            changeCount
              ? `파일 변경 ${changeCount}개를 반영했어요.`
              : "코드 변경을 반영했어요.",
            changeCount
              ? `Applied ${changeCount} file change${changeCount === 1 ? "" : "s"}.`
              : "Applied the code changes.",
          ),
          "🛠️",
        );
      }
      if (
        stage === "started" &&
        turnId &&
        item?.type === "commandExecution" &&
        isDiscordVerificationCommand(item.command)
      ) {
        const responseLanguage = discordLanguageForTurn(String(turnId));
        void sendDiscordProgress(
          agent,
          String(turnId),
          "VERIFYING",
          officeLanguageText(
            responseLanguage,
            "빌드와 테스트를 확인하고 있어요.",
            "Running build and test verification.",
          ),
          "🧪",
        );
      }
      if (stage === "completed" && item?.type === "agentMessage") {
        const visibleMessage = visibleAgentMessage(item.text ?? "");
        if (visibleMessage) database.setAgentMessage(agent.id, visibleMessage);
        if (turnId && item.phase === "commentary" && visibleMessage) {
          void sendDiscordProgress(
            agent,
            String(turnId),
            "UPDATE",
            visibleMessage,
            "💬",
          );
        }
        if (item.phase === "final_answer" || item.phase == null) {
          handleFinalAgentMessage(agent, item.text ?? "", threadId, turnId);
        }
      }
      addEvent(method, summary, item, agent, threadId, turnId);
    }
  }

  if (method === "thread/tokenUsage/updated" && agent) {
    const total = params.tokenUsage?.total as TokenUsage | undefined;
    if (total) database.setAgentUsage(agent.id, total);
  }

  if (method === "account/rateLimits/updated") {
    account = { ...account, rateLimits: params.rateLimits ?? null };
  }

  if (method === "account/updated") {
    account = {
      ...account,
      authMode: params.authMode ?? account.authMode,
      planType: params.planType ?? account.planType,
    };
  }

  if (method === "error" && agent) {
    database.setAgentRuntime(
      agent.id,
      "error",
      safeText(params.error?.message ?? params.message) || "Codex 오류",
    );
  }

  broadcast();
}

function approvalSummary(method: string, params: any) {
  if (method === "item/commandExecution/requestApproval") {
    return `명령 승인 요청: ${safeText(params.command, 160)}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return `파일 변경 승인 요청: ${safeText(params.reason) || "추가 쓰기 권한"}`;
  }
  if (method === "item/tool/requestUserInput") {
    return `응답 필요: ${safeText(params.questions?.[0]?.question)}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `추가 권한 승인 요청: ${safeText(params.reason)}`;
  }
  return `${method} 요청`;
}

function pendingApprovalForAgent(agent: AgentRecord) {
  return database
    .listPendingApprovals()
    .find(
      (approval) =>
        approval.agentId === agent.id ||
        (Boolean(agent.threadId) && approval.threadId === agent.threadId),
    );
}

function approvalDecision(
  approval: ReturnType<typeof pendingApprovalForAgent>,
  action: "accept" | "decline",
) {
  if (
    !approval ||
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(approval.method)
  ) {
    return null;
  }
  const available = Array.isArray((approval.params as any)?.availableDecisions)
    ? (approval.params as any).availableDecisions.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];
  const preferred =
    action === "accept"
      ? ["accept", "acceptForSession"]
      : ["decline", "cancel"];
  return preferred.find(
    (decision) => available.length === 0 || available.includes(decision),
  ) ?? null;
}

function isDiscordStatusInquiry(command: string) {
  return /^(?:야\s*)?(?:지금\s*)?(?:뭐\s*해|뭐\s*하(?:냐|세요|는\s*중(?:이야)?))\??$/u.test(
    command.trim().toLocaleLowerCase(),
  );
}

function notifyDiscordApproval(
  agent: AgentRecord,
  turnId: string | null,
  summary: string,
) {
  if (!turnId) return;
  setTimeout(() => {
    const tasks = discordProgressRoutesForTurn(turnId);
    const channels = new Set<string>();
    for (const task of tasks) {
      if (channels.has(task.channelId)) continue;
      channels.add(task.channelId);
      void discord
        .sendApprovalNeeded(
          task.channelId,
          agent.id,
          agent.shortRole,
          task.language === "en"
            ? "The agent needs approval to continue."
            : summary,
          task.language,
        )
        .then(() => {
          addEvent(
            "discord.approval_requested",
            `${agent.name} 디스코드 승인 요청`,
            { channelId: task.channelId },
            agent,
            agent.threadId,
            turnId,
          );
        })
        .catch((error) => {
          addEvent(
            "discord.sync_failed",
            "디스코드 승인 안내 실패",
            { error: error instanceof Error ? error.message : String(error) },
            agent,
            agent.threadId,
            turnId,
          );
        });
    }
  }, 500);
}

async function handleAgentToolCall(message: RpcEnvelope) {
  if (message.id === undefined) return;
  const params = message.params ?? {};
  const source = database.findAgentByThread(params.threadId);
  const input = params.arguments ?? {};
  try {
    if (!source) throw new Error("업무를 전달한 상주 에이전트를 찾을 수 없습니다");
    const target = input.target;
    const handoffMessage = safeText(input.message, 20_000);
    if (!handoffMessage) throw new Error("전달할 message가 필요합니다");
    const sourceTurnId = params.turnId ? String(params.turnId) : source.activeTurnId;
    const routes = sourceTurnId
      ? discordProgressRoutesForTurn(sourceTurnId)
      : [];
    const responseLanguage =
      routes[0]?.language ?? detectOfficeLanguage(handoffMessage);
    const delivery = await dispatchAgentHandoff(
      source,
      target,
      handoffMessage,
      responseLanguage,
    );
    if (delivery.result.turnId && routes.length) {
      discordProgressRoutes.set(String(delivery.result.turnId), routes);
      for (const route of routes) {
        void discord.sendHandoffUpdate(
          route.channelId,
          delivery.target.id,
          source.shortRole,
          delivery.target.shortRole,
        );
      }
    }
    codex.respond(message.id, {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: `${delivery.target.name}의 상주 스레드로 실제 전달했습니다. 결과는 완료 후 자동으로 돌아옵니다.`,
        },
      ],
    });
  } catch (error) {
    codex.respond(message.id, {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    });
  }
}

function handleServerRequest(message: RpcEnvelope) {
  if (message.id === undefined || !message.method) return;
  if (
    message.method === "item/tool/call" &&
    message.params?.namespace === "agent_office" &&
    message.params?.tool === "send_agent_message"
  ) {
    void handleAgentToolCall(message);
    return;
  }
  const requestId = String(message.id);
  const params = message.params ?? {};
  const agent = database.findAgentByThread(params.threadId);
  pendingServerRequests.set(requestId, message);
  database.addApproval({
    requestId,
    createdAt: new Date().toISOString(),
    agentId: agent?.id ?? null,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? null,
    method: message.method,
    summary: approvalSummary(message.method, params),
    params,
    status: "pending",
  });
  if (agent) {
    database.setAgentRuntime(
      agent.id,
      "needs_input",
      approvalSummary(message.method, params),
      params.turnId ?? agent.activeTurnId,
    );
    notifyDiscordApproval(
      agent,
      params.turnId ? String(params.turnId) : agent.activeTurnId,
      approvalSummary(message.method, params),
    );
  }
  addEvent(
    "approval.requested",
    approvalSummary(message.method, params),
    params,
    agent,
    params.threadId ?? null,
    params.turnId ?? null,
  );
  broadcast("approval", { requestId });
}

codex.on("notification", handleNotification);
codex.on("serverRequest", handleServerRequest);
codex.on("protocolError", (error: Error) => {
  addEvent("codex.protocol_error", error.message, null);
});
codex.on("stderr", (text: string) => {
  addEvent("codex.stderr", safeText(text, 300), { text });
});
codex.on("disconnected", (error: Error) => {
  officeStatus = "disconnected";
  account = { ...account, connected: false, error: error.message };
  database.setAllDisconnected();
  database.cancelPendingApprovals();
  pendingServerRequests.clear();
  relayRoutes.clear();
  inFlightHandoffs.clear();
  pendingUpstreamRoutes.clear();
  deliveredDiscordProgress.clear();
  discordProgressRoutes.clear();
  for (const discussion of [...discordDiscussions.values()]) {
    void failDiscordDiscussion(discussion, "Codex 연결이 끊어졌어요");
  }
  addEvent("office.disconnected", "Codex 연결이 끊어짐", {
    error: error.message,
  });
  broadcast();
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectCodex();
    }, 3_000);
  }
});

async function ensureAgentThread(agentId: string) {
  const agent = database.getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  if (agent.threadId) {
    try {
      await codex.request("thread/resume", {
        threadId: agent.threadId,
        model: agent.model ?? null,
        cwd: agent.cwd,
        approvalPolicy: agent.approvalPolicy,
        sandbox: agent.sandbox,
        developerInstructions: officeDeveloperInstructions(agent),
        excludeTurns: true,
      });
      database.setAgentRuntime(agent.id, "idle", "로그인 세션 연결됨", null);
      return database.getAgent(agent.id)!;
    } catch (error) {
      addEvent(
        "thread.resume_failed",
        `${agent.name} 기존 세션을 새로 연결합니다`,
        { error: error instanceof Error ? error.message : String(error) },
        agent,
      );
      database.setAgentThread(agent.id, null);
    }
  }

  const result = await codex.request("thread/start", {
    model: agent.model ?? null,
    cwd: agent.cwd,
    approvalPolicy: agent.approvalPolicy,
    sandbox: agent.sandbox,
    serviceName: "codex-agent-office",
    developerInstructions: officeDeveloperInstructions(agent),
    ephemeral: false,
    threadSource: "user",
    dynamicTools: officeDynamicTools,
  });
  const threadId = result?.thread?.id;
  if (!threadId) throw new Error(`Codex did not return a thread for ${agent.name}`);
  database.setAgentThread(agent.id, threadId);
  database.setAgentRuntime(agent.id, "idle", "상주 세션 준비됨", null);
  await codex
    .request("thread/name/set", {
      threadId,
      name: `Agent Office · ${agent.name}`,
    })
    .catch(() => undefined);
  addEvent(
    "agent.session_started",
    `${agent.name} 상주 세션 시작`,
    { threadId },
    database.getAgent(agent.id),
    threadId,
    null,
  );
  return database.getAgent(agent.id)!;
}

async function refreshAccount() {
  const [accountResult, rateResult, threadsResult] = await Promise.all([
    codex.request("account/read", { refreshToken: false }),
    codex.request("account/rateLimits/read", undefined).catch(() => null),
    codex
      .request("thread/list", {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
        archived: false,
        useStateDbOnly: true,
      })
      .catch(() => null),
  ]);
  const activeAccount = accountResult?.account;
  account = {
    connected: true,
    authMode: activeAccount?.type ?? "unknown",
    email: activeAccount?.type === "chatgpt" ? activeAccount.email : null,
    planType:
      activeAccount?.type === "chatgpt" ? activeAccount.planType ?? null : null,
    userAgent: codex.initializeResult?.userAgent ?? null,
    rateLimits: rateResult?.rateLimits ?? null,
    error: null,
  };
  threadCount = threadsResult?.data?.length ?? database.listAgents().length;
}

async function connectCodex() {
  try {
    officeStatus = "starting";
    await codex.start();
    await refreshAccount();
    for (const agent of database.listAgents()) {
      await ensureAgentThread(agent.id);
    }
    officeStatus = "connected";
    addEvent("office.connected", "ChatGPT 로그인 세션에 연결됨", {
      authMode: account.authMode,
      planType: account.planType,
      userAgent: account.userAgent,
    });
    broadcast();
  } catch (error) {
    officeStatus = "error";
    account = {
      ...account,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
    database.setAllDisconnected();
    addEvent("office.connection_failed", "Codex 로그인 세션 연결 실패", {
      error: account.error,
    });
    broadcast();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectCodex();
      }, 5_000);
    }
  }
}

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function setCors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  if (
    origin === "http://localhost:3000" ||
    origin === "http://127.0.0.1:3000"
  ) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
  request?: IncomingMessage,
) {
  if (request) setCors(request, response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function sendAgentMessage(
  agentId: string,
  text: string,
  context: {
    direction?: "user" | "system";
    sourceAgentId?: string;
  } = {},
) {
  if (!codex.connected) throw new Error("Codex 로그인 세션이 연결되지 않았습니다");
  let agent = await ensureAgentThread(agentId);
  const input = [{ type: "text", text, text_elements: [] }];
  database.addMessage(
    agent.id,
    context.direction ?? "user",
    text,
    agent.threadId,
    agent.activeTurnId,
  );
  const source = context.sourceAgentId
    ? database.getAgent(context.sourceAgentId)
    : null;
  database.setAgentRuntime(
    agent.id,
    "working",
    source ? `${source.name}의 전달을 확인하는 중` : "새 요청을 확인하는 중",
  );

  if (agent.activeTurnId) {
    const result = await codex.request("turn/steer", {
      threadId: agent.threadId,
      input,
      expectedTurnId: agent.activeTurnId,
    });
    addEvent(
      "agent.steered",
      `${agent.name} 진행 중인 작업에 메시지 전달`,
      { text, turnId: result.turnId, sourceAgentId: context.sourceAgentId ?? null },
      agent,
      agent.threadId,
      result.turnId,
    );
    return { threadId: agent.threadId, turnId: result.turnId, mode: "steer" };
  }

  const result = await codex.request("turn/start", {
    threadId: agent.threadId,
    input,
  });
  const turnId = result?.turn?.id;
  database.setAgentRuntime(agent.id, "working", "새 업무 시작", turnId);
  agent = database.getAgent(agent.id)!;
  addEvent(
    "agent.message_sent",
    source ? `${source.name} → ${agent.name} 업무 전달` : `${agent.name}에게 업무 전달`,
    { text, turnId, sourceAgentId: context.sourceAgentId ?? null },
    agent,
    agent.threadId,
    turnId,
  );
  return { threadId: agent.threadId, turnId, mode: "turn" };
}

function cleanDiscussionContribution(text: string) {
  return stripAgentHandoffs(text)
    .replace(/<office_summary>([\s\S]*?)<\/office_summary>/gi, "$1")
    .replace(/<office_details>([\s\S]*?)<\/office_details>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 900);
}

function cleanupDiscordDiscussion(discussionId: string) {
  discordDiscussions.delete(discussionId);
  for (const [turnId, route] of discussionTurnRoutes) {
    if (route.discussionId === discussionId) discussionTurnRoutes.delete(turnId);
  }
}

async function failDiscordDiscussion(
  discussion: DiscordDiscussion,
  reason: string,
) {
  cleanupDiscordDiscussion(discussion.id);
  addEvent(
    "discord.discussion_failed",
    "Discord 전체 호출 중단",
    { reason },
    database.getAgent("chief"),
  );
  await discord
    .sendResult(
      discussion.channelId,
      "chief",
      "CHIEF",
      "failed",
      officeLanguageText(
        discussion.language,
        `전체 호출이 중간에 멈췄어요. ${safeText(reason, 240)}`,
        `The group call stopped before completion. ${safeText(reason, 240)}`,
      ),
      discussion.language,
    )
    .catch(() => undefined);
  await discord.reactToMessage(
    discussion.channelId,
    discussion.messageId,
    "chief",
    "⚠️",
  );
}

async function startNextDiscordDiscussionTurn(
  discussion: DiscordDiscussion,
) {
  if (discussion.index >= discussion.participantIds.length) {
    addEvent(
      "discord.discussion_completed",
      "Discord 전체 호출 완료",
      { discussionId: discussion.id, answers: discussion.participantIds.length },
      database.getAgent("chief"),
    );
    discord.finishDiscussion(discussion.channelId);
    await discord.reactToMessage(
      discussion.channelId,
      discussion.messageId,
      "chief",
      "✅",
    );
    cleanupDiscordDiscussion(discussion.id);
    return;
  }

  const agentId = discussion.participantIds[discussion.index];
  const agent = database.getAgent(agentId);
  if (!agent) throw new Error(`전체 호출 대상을 찾을 수 없습니다: ${agentId}`);
  if (agent.activeTurnId) {
    throw new Error(`${agent.name}이 다른 작업 중이라 전체 호출을 이어갈 수 없습니다`);
  }
  const prompt = `[AGENT OFFICE @everyone 동일 질문]
사용자 질문: ${discussion.command}

${officeLanguageInstruction(discussion.language)}

다른 에이전트의 답을 기다리거나 참고하지 말고, ${agent.name} (${agent.shortRole}) 본인의 역할과 개성으로 이 질문에 직접 답하세요. 실제 작업, 도구 사용, 업무 위임, 의견 취합은 하지 마세요. 보고서 표식이나 태그 없이 2~4문장, 500자 이내로 자연스럽게 말하세요.`;
  const started = await sendAgentMessage(agent.id, prompt, {
    direction: "system",
  });
  if (!started.turnId) throw new Error(`${agent.name}의 답변이 시작되지 않았습니다`);
  discussionTurnRoutes.set(String(started.turnId), {
    discussionId: discussion.id,
    agentId: agent.id,
  });
  addEvent(
    "discord.discussion_turn_started",
    `${agent.name}에게 같은 질문 전달`,
    { discussionId: discussion.id, question: discussion.command },
    database.getAgent(agent.id),
    started.threadId,
    String(started.turnId),
  );
}

async function completeDiscordDiscussionTurn(
  route: { discussionId: string; agentId: string },
  text: string,
  failed = false,
) {
  const discussion = discordDiscussions.get(route.discussionId);
  const agent = database.getAgent(route.agentId);
  if (!discussion || !agent) return;
  const answer =
    cleanDiscussionContribution(text) ||
    officeLanguageText(
      discussion.language,
      failed ? "이번에는 답변을 받지 못했어요." : "답변을 짧게 정리하지 못했어요.",
      failed ? "No answer was returned this time." : "The answer could not be summarized.",
    );
  discussion.index += 1;
  addEvent(
    failed ? "discord.discussion_turn_failed" : "discord.discussion_turn_completed",
    `${agent.name} 답변 공개`,
    { discussionId: discussion.id, text: answer },
    agent,
  );
  try {
    await discord.sendDiscussionUpdate(
      discussion.channelId,
      agent.id,
      agent.shortRole,
      discussion.language === "en" ? "ANSWER" : "답변",
      answer,
      failed ? "⚠️" : "💬",
    );
    await startNextDiscordDiscussionTurn(discussion);
  } catch (error) {
    await failDiscordDiscussion(
      discussion,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function startDiscordDiscussion(input: DiscordCommandInput) {
  const active = [...discordDiscussions.values()][0];
  if (active) {
    return {
      shortRole: "CHIEF",
      acknowledgement: "지금 전체 호출이 하나 진행 중이에요. 끝나면 다음 질문을 받을게요.",
    };
  }
  const busy = configuration.agents
    .map((definition) => database.getAgent(definition.id))
    .filter((agent): agent is AgentRecord => Boolean(agent?.activeTurnId));
  if (busy.length) {
    return {
      shortRole: "CHIEF",
      acknowledgement: `${busy.map((agent) => agent.shortRole).join(", ")}가 작업 중이라 지금은 전체 호출을 시작하기 어려워요. 끝난 뒤 다시 불러주세요.`,
    };
  }
  const participantIds = configuration.agents.map((agent) => agent.id);
  const discussion: DiscordDiscussion = {
    id: `discussion-${Date.now()}`,
    channelId: input.channelId,
    messageId: input.messageId ?? null,
    command: input.command,
    participantIds,
    index: 0,
    language: detectOfficeLanguage(input.command),
  };
  discordDiscussions.set(discussion.id, discussion);
  addEvent(
    "discord.discussion_started",
    "Discord 전체 호출 시작",
    { discussionId: discussion.id, command: input.command, participantIds },
    database.getAgent("chief"),
  );
  try {
    await startNextDiscordDiscussionTurn(discussion);
    return { shortRole: "CHIEF" };
  } catch (error) {
    cleanupDiscordDiscussion(discussion.id);
    throw error;
  }
}

async function dispatchCommandCenter(
  text: string,
  onStarted?: (
    agent: AgentRecord,
    result: { threadId: string | null; turnId?: string | null },
  ) => void,
) {
  const responseLanguage = detectOfficeLanguage(text);
  const tagged = mentionedAgents(text);
  if (tagged.length > 1) {
    throw new Error("한 번에 한 명만 호출할 수 있습니다. 첫 담당자의 결과를 받은 뒤 다음 담당자를 호출하세요.");
  }
  const definition =
    tagged[0] ?? configuration.agents.find((agent) => agent.id === "chief");
  if (!definition) throw new Error("호출할 에이전트가 없습니다");
  const agent = database.getAgent(definition.id);
  if (!agent) throw new Error(`Unknown agent: ${definition.id}`);
  visitWhiteboard(
    agent.id,
    `화이트보드 호출 · ${safeText(text, 45)}`,
  );
  addEvent(
    "command_center.called",
    `COMMAND CENTER → ${agent.name} 호출`,
    { text, targetAgentId: agent.id },
    agent,
  );
  const result = await sendAgentMessage(
    agent.id,
    `[COMMAND CENTER 사용자 지시]\n${text}\n\n${officeLanguageInstruction(responseLanguage)}\n\n화이트보드에서 확인한 지시입니다. 자신의 역할로 직접 처리하세요. 다른 역할이 필요하면 한 번에 딱 한 명에게만 전달하고, 그 결과가 돌아온 뒤에만 다음 한 명에게 이어서 전달하세요.`,
  );
  onStarted?.(agent, result);
  const notionTask = await createNotionTask(agent, text, {
    threadId: result.threadId,
    turnId: result.turnId ?? null,
  });
  return {
    recipients: [
      {
        id: agent.id,
        name: agent.name,
        shortRole: agent.shortRole,
        ...result,
      },
    ],
    defaultedToChief: tagged.length === 0,
    notionUrl: notionTask?.pageUrl ?? null,
  };
}

async function handleDiscordCommand(input: DiscordCommandInput) {
  const agent = database.getAgent(input.agentId);
  if (!agent) throw new Error(`Unknown agent: ${input.agentId}`);
  const control = input.command.trim().replace(/^\//, "").toLocaleLowerCase();
  const statusLabels: Record<AgentStatus, string> = {
    offline: "오프라인",
    idle: "대기 중",
    working: "작업 중",
    delegating: "전달 중",
    meeting: "회의 중",
    waiting: "결과 대기 중",
    needs_input: "확인 필요",
    rate_limited: "사용량 한도 대기",
    error: "오류",
  };
  const tokenLabel = (value: number) =>
    new Intl.NumberFormat("ko-KR", { notation: "compact" }).format(value);

  if (input.audience === "everyone") {
    return startDiscordDiscussion(input);
  }

  if (["상태", "status"].includes(control) || isDiscordStatusInquiry(control)) {
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name}은 지금 ${statusLabels[agent.status]}이에요. ${agent.activity}`,
    };
  }
  if (["사용량", "usage"].includes(control)) {
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name} 누적 ${tokenLabel(agent.usage.totalTokens)}토큰이에요. 입력 ${tokenLabel(agent.usage.inputTokens)} · 출력 ${tokenLabel(agent.usage.outputTokens)} · 캐시 ${tokenLabel(agent.usage.cachedInputTokens)} · ${agent.model ?? "기본 모델"}`,
    };
  }
  if (["중단", "stop", "cancel"].includes(control)) {
    if (!agent.threadId || !agent.activeTurnId) {
      return {
        shortRole: agent.shortRole,
        acknowledgement: `${agent.name}은 지금 중단할 작업이 없어요.`,
      };
    }
    await codex.request("turn/interrupt", {
      threadId: agent.threadId,
      turnId: agent.activeTurnId,
    });
    addEvent(
      "discord.command_interrupted",
      `Discord → ${agent.name} 작업 중단`,
      null,
      agent,
      agent.threadId,
      agent.activeTurnId,
    );
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name} 작업을 중단했어요.`,
    };
  }
  if (["도움말", "help"].includes(control)) {
    return {
      shortRole: agent.shortRole,
      acknowledgement: "그냥 업무를 말하면 바로 시작해요. 빠른 명령은 `상태`, `사용량`, `승인`, `거절`, `중단`이에요.",
    };
  }

  const pendingApproval = pendingApprovalForAgent(agent);
  if (["승인", "approve"].includes(control)) {
    if (!pendingApproval) {
      return {
        shortRole: agent.shortRole,
        acknowledgement: `${agent.name}은 지금 기다리는 승인이 없어요.`,
      };
    }
    const decision = approvalDecision(pendingApproval, "accept");
    if (!decision) {
      return {
        shortRole: agent.shortRole,
        acknowledgement: "이건 선택지가 필요한 질문이라 대시보드에서 확인해주세요.",
      };
    }
    await respondToApproval(pendingApproval.requestId, { decision });
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name} 승인했어요. 이어서 진행할게요.`,
    };
  }
  if (["거절", "decline", "deny"].includes(control)) {
    if (!pendingApproval) {
      return {
        shortRole: agent.shortRole,
        acknowledgement: `${agent.name}은 지금 기다리는 승인이 없어요.`,
      };
    }
    const decision = approvalDecision(pendingApproval, "decline");
    if (!decision) {
      return {
        shortRole: agent.shortRole,
        acknowledgement: "이건 선택지가 필요한 질문이라 대시보드에서 확인해주세요.",
      };
    }
    await respondToApproval(pendingApproval.requestId, { decision });
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name} 요청은 거절했어요.`,
    };
  }
  if (pendingApproval) {
    return {
      shortRole: agent.shortRole,
      acknowledgement: `${agent.name}이 지금 ${pendingApproval.summary} 승인을 기다리고 있어요. \`승인\` 또는 \`중단\`이라고 해주세요.`,
    };
  }

  if (discordDiscussions.size) {
    return {
      shortRole: agent.shortRole,
      acknowledgement: "지금 전체 호출 중이라 새 업무는 답변이 모두 끝난 뒤 받을게요.",
    };
  }

  const reportToForum =
    input.source === "project"
      ? false
      : input.source === "voice" && input.voiceStage === "interview"
      ? false
      : shouldReportDiscordWork(input.command);
  const responseLanguage = detectOfficeLanguage(input.command);

  if (input.source === "dm" || input.source === "voice") {
    const voicePrompt =
      input.source === "voice"
        ? `[Discord CHIEF 음성 입력 · ${input.voiceStage ?? "direct"}]\n${input.command}\n\n${officeLanguageInstruction(responseLanguage)}\n\n대표님의 음성을 로컬에서 받아쓴 내용입니다. 자신의 역할로 직접 처리하고, 질문은 한 번에 하나만 하며, 사용자에게는 꼭 필요한 내용만 짧고 자연스럽게 답하세요.`
        : null;
    const started = await sendAgentMessage(
      agent.id,
      voicePrompt ??
        `[Discord DM 사용자 지시]\n${input.command}\n\n${officeLanguageInstruction(responseLanguage)}\n\n자신의 역할로 직접 처리하고, 사용자에게는 완료한 내용과 꼭 필요한 결과만 짧고 자연스럽게 답하세요.`,
    );
    database.addDiscordTask({
      turnId: started.turnId ?? null,
      agentId: agent.id,
      channelId: input.channelId,
      sourceMessageId: input.messageId,
      userId: input.userId,
      reportToForum,
      responseLanguage,
    });
    void sendDiscordProgress(
      agent,
      started.turnId ?? null,
      "STARTED",
      officeLanguageText(
        responseLanguage,
        "요청을 받았어요. 작업을 시작합니다.",
        "Request received. Starting the work now.",
      ),
      "🚀",
    );
    if (input.source === "dm" || reportToForum) {
      await createNotionTask(agent, input.command, {
        threadId: started.threadId,
        turnId: started.turnId ?? null,
      });
    }
    addEvent(
      input.source === "voice"
        ? "discord.voice_received"
        : "discord.dm_received",
      input.source === "voice"
        ? `Discord 음성 → ${agent.name} 업무 전달`
        : `Discord DM → ${agent.name} 업무 전달`,
      { targetAgentId: agent.id, voiceStage: input.voiceStage ?? null },
      database.getAgent(agent.id),
      started.threadId,
      started.turnId ?? null,
    );
    return { shortRole: agent.shortRole };
  }

  const projectCommand = input.projectTitle
    ? `[PROJECT: ${input.projectTitle}]\n${input.command}`
    : input.command;
  const result = await dispatchCommandCenter(
    `@${input.agentId.toUpperCase()} ${projectCommand}`,
    (agent, started) => {
      database.addDiscordTask({
        turnId: started.turnId ?? null,
        agentId: agent.id,
        channelId: input.channelId,
        sourceMessageId: input.messageId,
        userId: input.userId,
        reportToForum,
        projectThreadId: input.projectThreadId,
        responseLanguage,
      });
    },
  );
  const recipient = result.recipients[0];
  if (!recipient) throw new Error("담당자를 호출하지 못했습니다");
  void sendDiscordProgress(
    database.getAgent(recipient.id) ?? agent,
    recipient.turnId ?? null,
    "STARTED",
    officeLanguageText(
      responseLanguage,
      "요청을 받았어요. 작업을 시작합니다.",
      "Request received. Starting the work now.",
    ),
    "🚀",
  );
  addEvent(
    input.source === "project"
      ? "discord.project_started"
      : input.source === "mention"
      ? "discord.mention_received"
      : "discord.command_received",
    input.source === "project"
      ? `Discord 프로젝트 → ${recipient.name} 업무 전달`
      : input.source === "mention"
      ? `Discord 멘션 → ${recipient.name} 업무 전달`
      : `Discord → ${recipient.name} 업무 전달`,
    { targetAgentId: recipient.id },
    database.getAgent(recipient.id),
    recipient.threadId,
    recipient.turnId ?? null,
  );
  return { shortRole: recipient.shortRole };
}

async function respondToApproval(requestId: string, body: any) {
  const stored = database.getApproval(requestId);
  const pending = pendingServerRequests.get(requestId);
  if (!stored || !pending || pending.id === undefined) {
    throw new Error("이 승인 요청은 현재 Codex 세션에서 더 이상 유효하지 않습니다");
  }

  const decision = body.decision;
  let result: unknown;
  if (
    stored.method === "item/commandExecution/requestApproval" ||
    stored.method === "item/fileChange/requestApproval"
  ) {
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
      throw new Error("지원하지 않는 승인 결정입니다");
    }
    const availableDecisions = Array.isArray((stored.params as any)?.availableDecisions)
      ? (stored.params as any).availableDecisions.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : [];
    if (
      availableDecisions.length > 0 &&
      !availableDecisions.includes(decision)
    ) {
      throw new Error("현재 Codex 요청에서 제공되지 않은 승인 결정입니다");
    }
    result = { decision };
  } else if (stored.method === "item/tool/requestUserInput") {
    if (!body.answers || typeof body.answers !== "object") {
      throw new Error("질문에 대한 answers 값이 필요합니다");
    }
    result = { answers: body.answers };
  } else if (stored.method === "item/permissions/requestApproval") {
    if (!body.permissions || !body.scope) {
      throw new Error("permissions와 scope가 필요합니다");
    }
    result = { permissions: body.permissions, scope: body.scope };
  } else {
    throw new Error(`아직 지원하지 않는 요청 유형입니다: ${stored.method}`);
  }

  codex.respond(pending.id, result);
  pendingServerRequests.delete(requestId);
  const status =
    decision === "decline"
      ? "declined"
      : decision === "cancel"
        ? "cancelled"
        : "approved";
  database.setApprovalStatus(requestId, status);
  const agent = stored.agentId ? database.getAgent(stored.agentId) : null;
  if (agent) {
    database.setAgentRuntime(
      agent.id,
      "working",
      status === "approved" ? "승인 후 작업 재개" : "사용자 결정 반영 중",
    );
  }
  addEvent(
    "approval.responded",
    `${stored.summary} · ${status}`,
    { requestId, status },
    agent,
    stored.threadId,
    stored.turnId,
  );
  broadcast();
  return { requestId, status };
}

const httpServer = createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(
        response,
        officeStatus === "connected" ? 200 : 503,
        {
          ok: officeStatus === "connected",
          officeStatus,
          codexConnected: codex.connected,
          discordConnected: discord.getState().connected,
          authMode: account.authMode,
          version: account.userAgent,
        },
        request,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, getOfficeState(), request);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      const models = await codex.request("model/list", {
        limit: 100,
        includeHidden: false,
      });
      json(response, 200, models, request);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      sseClients.add(response);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(response);
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/dispatch") {
      const body = await readBody(request);
      const text = safeText(body.text, 20_000);
      if (!text) throw new Error("화이트보드에 전달할 지시가 필요합니다");
      const result = await dispatchCommandCenter(text);
      json(response, 202, result, request);
      return;
    }

    const agentMessageMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/message$/,
    );
    if (request.method === "POST" && agentMessageMatch) {
      const body = await readBody(request);
      const text = safeText(body.text, 20_000);
      if (!text) throw new Error("메시지 내용이 필요합니다");
      const result = await sendAgentMessage(
        decodeURIComponent(agentMessageMatch[1]),
        text,
      );
      json(response, 202, result, request);
      return;
    }

    const agentModelMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/model$/,
    );
    if (request.method === "POST" && agentModelMatch) {
      if (!codex.connected) {
        throw new Error("Codex 로그인 세션이 연결되지 않았습니다");
      }
      const agentId = decodeURIComponent(agentModelMatch[1]);
      const agent = database.getAgent(agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      if (!agent.threadId) throw new Error("연결된 에이전트 스레드가 없습니다");
      if (agent.activeTurnId) {
        throw new Error("작업이 끝난 뒤 모델을 바꿔주세요");
      }
      const body = await readBody(request);
      const model = safeText(body.model, 100);
      if (!model) throw new Error("변경할 모델이 필요합니다");
      const modelResult = await codex.request("model/list", {
        limit: 100,
        includeHidden: false,
      });
      const availableModels = Array.isArray(modelResult?.data)
        ? modelResult.data
        : [];
      const selectedModel = availableModels.find(
        (item: { id?: unknown; model?: unknown }) =>
          item.id === model || item.model === model,
      );
      if (!selectedModel) throw new Error("현재 Codex 세션에서 사용할 수 없는 모델입니다");
      await codex.request("thread/settings/update", {
        threadId: agent.threadId,
        model,
      });
      database.setSetting(`agent.model.${agent.id}`, model);
      database.setAgentModel(agent.id, model);
      const updatedAgent = database.getAgent(agent.id)!;
      addEvent(
        "agent.model_updated",
        `${agent.name} 모델 변경 · ${String(selectedModel.displayName ?? model)}`,
        { model },
        updatedAgent,
      );
      broadcast();
      json(response, 200, { ok: true, agent: updatedAgent }, request);
      return;
    }

    const interruptMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/interrupt$/,
    );
    if (request.method === "POST" && interruptMatch) {
      const agent = database.getAgent(decodeURIComponent(interruptMatch[1]));
      if (!agent?.threadId || !agent.activeTurnId) {
        throw new Error("중단할 활성 작업이 없습니다");
      }
      await codex.request("turn/interrupt", {
        threadId: agent.threadId,
        turnId: agent.activeTurnId,
      });
      json(response, 202, { ok: true }, request);
      return;
    }

    const approvalMatch = url.pathname.match(
      /^\/api\/approvals\/([^/]+)\/respond$/,
    );
    if (request.method === "POST" && approvalMatch) {
      const body = await readBody(request);
      const result = await respondToApproval(
        decodeURIComponent(approvalMatch[1]),
        body,
      );
      json(response, 200, result, request);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/system/reconnect") {
      await codex.stop();
      await connectCodex();
      json(response, 200, { ok: officeStatus === "connected" }, request);
      return;
    }

    json(response, 404, { error: "Not found" }, request);
  } catch (error) {
    json(
      response,
      400,
      { error: error instanceof Error ? error.message : String(error) },
      request,
    );
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Agent Office bridge: http://${HOST}:${PORT}`);
  void initializeNotion();
  void discord.start();
  void connectCodex();
});

async function shutdown() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const timer of movementTimers.values()) clearTimeout(timer);
  for (const client of sseClients) client.end();
  httpServer.close();
  await discord.stop();
  await codex.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
