"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  AgentMovement,
  AgentRecord,
  ApprovalRecord,
  OfficeState,
  TokenUsage,
  WorkerRecord,
} from "../orchestrator/types";

const emptyState: OfficeState = {
  generatedAt: new Date(0).toISOString(),
  officeStatus: "starting",
  account: {
    connected: false,
    authMode: "unknown",
    email: null,
    planType: null,
    userAgent: null,
    rateLimits: null,
    error: null,
  },
  notion: {
    configured: false,
    connected: false,
    databaseUrl: null,
    error: null,
  },
  discord: {
    configured: false,
    connected: false,
    botName: null,
    error: null,
    voice: {
      configured: false,
      connected: false,
      mode: "idle",
      transcribing: false,
      bufferedSegments: 0,
      error: null,
    },
  },
  agents: [],
  movements: [],
  workers: [],
  projects: [],
  events: [],
  approvals: [],
  threadCount: 0,
};

type Locale = "ko" | "en";
const LOCALE_STORAGE_KEY = "agent-office-locale";
const LOCALE_CHANGE_EVENT = "agent-office-locale-change";

function localeSnapshot(): Locale {
  return window.localStorage.getItem(LOCALE_STORAGE_KEY) === "en" ? "en" : "ko";
}

function localeServerSnapshot(): Locale {
  return "ko";
}

function subscribeLocale(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(LOCALE_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(LOCALE_CHANGE_EVENT, onStoreChange);
  };
}

const statusMeta = {
  offline: { tone: "muted" },
  idle: { tone: "green" },
  working: { tone: "blue" },
  delegating: { tone: "purple" },
  meeting: { tone: "purple" },
  waiting: { tone: "amber" },
  needs_input: { tone: "amber" },
  rate_limited: { tone: "red" },
  error: { tone: "red" },
} as const;

const statusLabels: Record<Locale, Record<AgentRecord["status"], string>> = {
  ko: {
    offline: "오프라인",
    idle: "대기",
    working: "작업 중",
    delegating: "위임 중",
    meeting: "회의 중",
    waiting: "결과 대기",
    needs_input: "확인 필요",
    rate_limited: "한도 대기",
    error: "오류",
  },
  en: {
    offline: "Offline",
    idle: "Idle",
    working: "Working",
    delegating: "Delegating",
    meeting: "Meeting",
    waiting: "Waiting",
    needs_input: "Needs input",
    rate_limited: "Rate limited",
    error: "Error",
  },
};

const uiCopy = {
  ko: {
    korean: "한국어",
    english: "English",
    language: "표시 언어",
    closeBubble: "말풍선 닫기",
    approvalPending: "승인 대기",
    select: "선택…",
    sendAnswer: "답변 전달",
    permissionInCodex: "세부 권한 요청은 Codex 앱에서 확인하세요.",
    decline: "거절",
    cancelTask: "작업 취소",
    approveOnce: "이번만 승인",
    approveSession: "세션 승인",
    commandSequence: "한 번에 한 명 · 완료 후 다음 담당자",
    waitingBridge: "로컬 Agent Office 브리지를 기다리는 중입니다.",
    reconnecting: "실시간 연결을 다시 시도하는 중입니다.",
    boardEmpty: "오른쪽 명령창에서 업무를 보내면 여기에 붙어요.",
    requestFailed: "요청을 처리하지 못했습니다",
    notionSaved: "불렀어요 · 노션에도 적어뒀어요",
    taskStarted: "불렀어요 · 작업 시작했어요",
    modelChanged: "로 바꿨어요.",
    discordWaiting: "디스코드 연결 대기 중",
    openNotion: "Agent Office 노션 업무 보드 열기",
    notionWaiting: "노션 연결 대기 중",
    operations: "운영 현황",
    residentSessions: "상주 세션",
    allCodexThreads: "전체 Codex 스레드",
    dispatchedWorkers: "파견 워커",
    cumulative: "누적",
    pendingApprovals: "승인 대기",
    userCheckRequired: "사용자 확인 필요",
    tokenUsage: "토큰 사용",
    monitoredSessions: "관제된 상주 세션",
    apiEquivalent: "API 환산 비용",
    standardPriceExcluded: "표준 단가 · 단가 제외",
    standardPriceCached: "표준 단가 · 캐시 할인 반영",
    codexLimit: "Codex 한도",
    officeTitle: "에이전트 오피스",
    idle: "대기",
    work: "작업",
    review: "확인",
    commandBoard: "중앙 업무 화이트보드",
    attachNewTask: "오른쪽에서 새 업무를 붙여주세요",
    status: "상태",
    currentActivity: "현재 활동",
    lastEvent: "마지막 이벤트",
    permissions: "권한",
    modelHelp: "선택한 에이전트의 다음 작업부터 적용",
    defaultModel: "기본",
    modelBusy: "지금 작업이 끝나면 바꿀 수 있어요.",
    input: "입력",
    output: "출력",
    cache: "캐시",
    apiEquivalentShort: "API 환산",
    unavailablePrice: "단가 없음",
    latestResponse: "최근 응답",
    noResponse: "아직 전달된 응답이 없습니다.",
    taskDetails: "작업 상세 보기",
    taskDetailsHint: "근거 · 수행 내역 · 확인 방법",
    attachToBoard: "화이트보드에 업무 붙이기",
    selectAssignee: "화이트보드 담당자 선택",
    commandPlaceholder: "@PM 내일 할 일 정리해줘 · Enter 전송 · Shift+Enter 줄바꿈",
    stop: "중단",
    attaching: "붙이는 중…",
    attach: "화이트보드에 붙이기",
    selectAgent: "에이전트를 선택하세요.",
    liveActivity: "실시간 수행 내역",
    approvalsAndQuestions: "승인 및 질문",
    noApprovals: "대기 중인 승인이 없습니다",
    approvalSafety: "위험한 작업은 이곳에서 멈추고 확인을 요청합니다.",
  },
  en: {
    korean: "한국어",
    english: "English",
    language: "Display language",
    closeBubble: "Close speech bubble",
    approvalPending: "Awaiting approval",
    select: "Select…",
    sendAnswer: "Send answer",
    permissionInCodex: "Review detailed permission requests in the Codex app.",
    decline: "Decline",
    cancelTask: "Cancel task",
    approveOnce: "Approve once",
    approveSession: "Approve session",
    commandSequence: "One agent at a time · Next starts after completion",
    waitingBridge: "Waiting for the local Agent Office bridge.",
    reconnecting: "Reconnecting to the live event stream.",
    boardEmpty: "Send a task from the command panel to pin it here.",
    requestFailed: "Unable to process the request",
    notionSaved: "called · also logged in Notion",
    taskStarted: "called · task started",
    modelChanged: " selected.",
    discordWaiting: "Waiting for Discord connection",
    openNotion: "Open the Agent Office task board in Notion",
    notionWaiting: "Waiting for Notion connection",
    operations: "Operations overview",
    residentSessions: "Resident sessions",
    allCodexThreads: "Total Codex threads",
    dispatchedWorkers: "Dispatched workers",
    cumulative: "All time",
    pendingApprovals: "Pending approvals",
    userCheckRequired: "Needs your review",
    tokenUsage: "Token usage",
    monitoredSessions: "Monitored resident sessions",
    apiEquivalent: "API-equivalent cost",
    standardPriceExcluded: "Standard pricing · unpriced",
    standardPriceCached: "Standard pricing · cache discount included",
    codexLimit: "Codex limit",
    officeTitle: "Agent Office",
    idle: "Idle",
    work: "Working",
    review: "Review",
    commandBoard: "Central command board",
    attachNewTask: "Pin a new task from the panel on the right",
    status: "Status",
    currentActivity: "Current activity",
    lastEvent: "Last event",
    permissions: "Permissions",
    modelHelp: "Applies to this agent's next task",
    defaultModel: "Default",
    modelBusy: "You can change this after the current task finishes.",
    input: "Input",
    output: "Output",
    cache: "Cache",
    apiEquivalentShort: "API equivalent",
    unavailablePrice: "pricing unavailable",
    latestResponse: "Latest response",
    noResponse: "No response has been received yet.",
    taskDetails: "View task details",
    taskDetailsHint: "Evidence · work log · verification",
    attachToBoard: "Pin a task to the command board",
    selectAssignee: "Select an assignee",
    commandPlaceholder: "@PM Plan tomorrow's priorities · Enter to send · Shift+Enter for a new line",
    stop: "Stop",
    attaching: "Pinning…",
    attach: "Pin to board",
    selectAgent: "Select an agent.",
    liveActivity: "Live activity",
    approvalsAndQuestions: "Approvals and questions",
    noApprovals: "No approvals are waiting",
    approvalSafety: "Risky actions pause here and wait for your confirmation.",
  },
} as const;

const englishAgentCopy: Record<string, { name: string; role: string }> = {
  chief: { name: "Chief of Staff", role: "Operations · Scheduling · Briefings" },
  pm: { name: "Project Manager", role: "Projects · Timelines · Worker coordination" },
  engineer: { name: "Systems Engineer", role: "Automation · Incidents · Infrastructure" },
  finance: { name: "Finance Manager", role: "Cost · Usage · Budget" },
  dispatch: { name: "Dispatch Manager", role: "Sub-agents · External assignments" },
  research: { name: "Researcher", role: "Research · Source validation · Comparisons" },
  design: { name: "Product Designer", role: "UI · UX · Visual systems" },
  qa: { name: "QA Lead", role: "Testing · Reviews · Regression checks" },
};

function agentDisplayName(agent: AgentRecord, locale: Locale) {
  return locale === "en" ? englishAgentCopy[agent.id]?.name ?? agent.name : agent.name;
}

function agentDisplayRole(agent: AgentRecord, locale: Locale) {
  return locale === "en" ? englishAgentCopy[agent.id]?.role ?? agent.role : agent.role;
}

function translateActivity(activity: string, locale: Locale) {
  if (locale === "ko") return activity;
  const exact: Record<string, string> = {
    "로그인 세션 연결됨": "Authenticated session connected",
    "연결 대기 중": "Waiting for connection",
    "새 업무 시작": "New task started",
    "작업이 중단됨": "Task stopped",
    "결과 대기 중": "Waiting for results",
    "사용자 확인 필요": "Needs user input",
    "자리로 돌아가는 중": "Returning to desk",
  };
  return exact[activity] ?? activity;
}

type OfficeStyle = CSSProperties & {
  "--agent-color"?: string;
  "--agent-accent"?: string;
  "--x"?: string;
  "--y"?: string;
  "--delay"?: string;
};

type LeisureActivity = {
  kind: "coffee" | "chat" | "nap" | "stretch";
  label: string;
  position: { x: number; y: number };
};

type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
};

type ApiTokenPrice = {
  input: number;
  cachedInput: number;
  output: number;
};

// Standard text-token prices in USD per 1M tokens, checked 2026-07-21.
const API_TOKEN_PRICES: Record<string, ApiTokenPrice> = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
};

function bridgeUrl() {
  if (typeof window === "undefined") return "http://127.0.0.1:8788";
  return `${window.location.protocol}//${window.location.hostname}:8788`;
}

function formatNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", {
    notation: "compact",
  }).format(value);
}

function formatUsd(value: number) {
  const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function estimateStandardApiCost(usage: TokenUsage, model?: string) {
  const price = model ? API_TOKEN_PRICES[model] : undefined;
  if (!price) return null;
  const cachedInput = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);
  return (
    (uncachedInput * price.input +
      cachedInput * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

function formatTime(value: string | null, locale: Locale) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.nativeEvent.isComposing
  ) {
    return;
  }
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function spokeRecently(
  state: OfficeState,
  agentId: string,
  now: Date,
) {
  const cutoff = now.getTime() - 18_000;
  return state.events.some((event) => {
    const payload = event.payload as { type?: string } | null;
    return (
      event.agentId === agentId &&
      event.type === "item/completed" &&
      payload?.type === "agentMessage" &&
      new Date(event.createdAt).getTime() >= cutoff
    );
  });
}

function getDayPeriod(now: Date) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 8) return "morning";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

function secureRandomUnit() {
  const values = new Uint32Array(1);
  window.crypto.getRandomValues(values);
  return values[0] / 4_294_967_296;
}

function randomBetween(min: number, max: number) {
  return Math.floor(min + secureRandomUnit() * (max - min + 1));
}

function createRandomLeisureActivities(agents: AgentRecord[], locale: Locale) {
  const activities: Record<string, LeisureActivity> = {};
  if (!agents.length) return activities;
  const shuffled = [...agents];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(secureRandomUnit() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  const roll = secureRandomUnit();

  if (roll < 0.3) {
    const agent = shuffled[0];
    activities[agent.id] = {
      kind: "coffee",
      label: locale === "ko" ? "커피 타는 중…" : "Making coffee…",
      position: { x: 14, y: 75 },
    };
  } else if (roll < 0.5 && shuffled.length > 1) {
    const positions = [
      { x: 44, y: 63 },
      { x: 50, y: 66 },
      { x: 56, y: 63 },
    ];
    const count = Math.min(randomBetween(2, 3), shuffled.length);
    for (let index = 0; index < count; index += 1) {
      const agent = shuffled[index];
      activities[agent.id] = {
        kind: "chat",
        label: locale === "ko" ? "수다 중…" : "Chatting…",
        position: positions[index],
      };
    }
  } else if (roll < 0.72) {
    const agent = shuffled[0];
    activities[agent.id] = {
      kind: "nap",
      label: locale === "ko" ? "낮잠 중… Zzz" : "Power nap… Zzz",
      position: { x: agent.seat.x + 2, y: agent.seat.y + 1 },
    };
  } else {
    const agent = shuffled[0];
    activities[agent.id] = {
      kind: "stretch",
      label: locale === "ko" ? "기지개 켜는 중…" : "Stretching…",
      position: { x: agent.seat.x, y: agent.seat.y },
    };
  }
  return activities;
}

function getRateLimit(rateLimits: unknown) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const value = rateLimits as {
    primary?: {
      usedPercent?: number;
      windowDurationMins?: number | null;
      resetsAt?: number | null;
    } | null;
    secondary?: {
      usedPercent?: number;
      windowDurationMins?: number | null;
      resetsAt?: number | null;
    } | null;
    credits?: { balance?: string | null; unlimited?: boolean } | null;
    limitName?: string | null;
  };
  return value;
}

function Desk({ agent }: { agent: AgentRecord }) {
  const active = !["offline", "idle"].includes(agent.status);
  return (
    <div
      className={`desk ${active ? "desk-active" : ""}`}
      style={
        {
          "--x": `${agent.seat.x}%`,
          "--y": `${agent.seat.y}%`,
          "--agent-color": agent.color,
        } as OfficeStyle
      }
      aria-hidden="true"
    >
      <div className="desk-monitor">
        <span />
      </div>
      <div className="desk-top" />
      <div className="desk-chair" />
    </div>
  );
}

function movementPosition(
  agent: AgentRecord,
  movement: AgentMovement | undefined,
  agents: AgentRecord[],
  leisure?: LeisureActivity,
) {
  if (!movement) return leisure?.position ?? agent.seat;
  if (movement.destination === "seat") return agent.seat;
  if (movement.destination === "whiteboard") return { x: 50, y: 43 };
  const target = agents.find((item) => item.id === movement.targetAgentId);
  if (!target) return agent.seat;
  const approachFromLeft = agent.seat.x <= target.seat.x;
  return {
    x: target.seat.x + (approachFromLeft ? -7 : 7),
    y: Math.min(82, target.seat.y + 8),
  };
}

function PixelAgent({
  agent,
  agents,
  locale,
  movement,
  leisure,
  speaking,
  dismissed,
  index,
  selected,
  onSelect,
  onDismiss,
}: {
  agent: AgentRecord;
  agents: AgentRecord[];
  locale: Locale;
  movement: AgentMovement | undefined;
  leisure?: LeisureActivity;
  speaking: boolean;
  dismissed: boolean;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDismiss: () => void;
}) {
  const meta = statusMeta[agent.status];
  const statusLabel = statusLabels[locale][agent.status];
  const speech = agent.lastMessage.trim();
  const position = movementPosition(agent, movement, agents, leisure);
  const bubbleSide =
    position.x < 38 ? "right" : position.x > 62 ? "left" : "center";
  return (
    <div
      className={`pixel-agent status-${agent.status} bubble-${bubbleSide} ${movement ? "is-walking" : ""} ${leisure ? `is-leisure leisure-${leisure.kind}` : ""} ${speech ? "has-speech" : ""} ${speaking ? "is-speaking" : ""} ${selected ? "selected" : ""}`}
      style={
        {
          "--x": `${position.x}%`,
          "--y": `${position.y}%`,
          "--agent-color": agent.color,
          "--agent-accent": agent.accent,
          "--delay": `${index * -0.7}s`,
        } as OfficeStyle
      }
    >
      {speech && !dismissed ? (
        <div className="agent-bubble" aria-live="polite">
          <button
            className="bubble-close"
            type="button"
            onClick={onDismiss}
            aria-label={`${agentDisplayName(agent, locale)} ${uiCopy[locale].closeBubble}`}
          >
            ×
          </button>
          <div className="bubble-copy">{speech}</div>
        </div>
      ) : null}
      <button
        type="button"
        className="agent-select-button"
        onClick={onSelect}
        aria-label={`${agentDisplayName(agent, locale)}, ${statusLabel}`}
      >
        <span className="agent-nameplate">
          <i className={`status-dot tone-${meta.tone}`} />
          {agent.shortRole}
        </span>
        {movement || leisure ? (
          <span className="movement-tag">{movement?.label ?? leisure?.label}</span>
        ) : null}
        <span className="agent-floor-shadow" aria-hidden="true" />
        <span className={`pixel-animal animal-${agent.id}`} aria-hidden="true">
          <i className="animal-tail" />
          <i className="animal-ear ear-left" />
          <i className="animal-ear ear-right" />
          <i className="animal-head">
            <b />
            <b />
            <em />
          </i>
          <i className="animal-muzzle" />
          <i className="animal-body" />
          <i className="animal-arm arm-left" />
          <i className="animal-arm arm-right" />
          <i className="animal-leg leg-left" />
          <i className="animal-leg leg-right" />
        </span>
      </button>
    </div>
  );
}

function PixelWorker({
  worker,
  parent,
  index,
}: {
  worker: WorkerRecord;
  parent: AgentRecord | undefined;
  index: number;
}) {
  const x = parent ? parent.seat.x - 6 + (index % 3) * 4 : 7 + index * 4;
  const y = parent ? parent.seat.y + 7 + Math.floor(index / 3) * 4 : 88;
  return (
    <div
      className={`pixel-worker worker-${worker.status}`}
      style={
        {
          "--x": `${x}%`,
          "--y": `${y}%`,
          "--agent-color": parent?.accent ?? "#ff9b68",
          "--delay": `${index * -0.4}s`,
        } as OfficeStyle
      }
      title={`${worker.nickname} · ${worker.activity}`}
    >
      <span className="worker-tag">{worker.nickname}</span>
      <span className="worker-head" />
      <span className="worker-body" />
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone = "plain",
}: {
  label: string;
  value: string | number;
  note: string;
  tone?: "plain" | "green" | "amber" | "red";
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function ApprovalCard({
  approval,
  onRespond,
  locale,
}: {
  approval: ApprovalRecord;
  onRespond: (approval: ApprovalRecord, body: unknown) => Promise<void>;
  locale: Locale;
}) {
  const copy = uiCopy[locale];
  const params = approval.params as {
    command?: string;
    reason?: string;
    questions?: Array<{
      id: string;
      question: string;
      options?: Array<{ label: string }> | null;
    }>;
    availableDecisions?: Array<string | Record<string, unknown>> | null;
  };
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const needsAnswer = approval.method === "item/tool/requestUserInput";
  const availableDecisions = (params.availableDecisions ?? []).filter(
    (decision): decision is string => typeof decision === "string",
  );
  const allows = (decision: string) =>
    availableDecisions.length === 0 || availableDecisions.includes(decision);

  async function respond(body: unknown) {
    setBusy(true);
    try {
      await onRespond(approval, body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span>{copy.approvalPending}</span>
        <time>{formatTime(approval.createdAt, locale)}</time>
      </div>
      <strong>{approval.summary}</strong>
      {params.command ? <code>{params.command}</code> : null}
      {params.reason ? <p>{params.reason}</p> : null}
      {needsAnswer ? (
        <div className="approval-questions">
          {(params.questions ?? []).map((question) => (
            <label key={question.id}>
              <span>{question.question}</span>
              {question.options?.length ? (
                <select
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                >
                  <option value="">{copy.select}</option>
                  {question.options.map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                />
              )}
            </label>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              respond({
                answers: Object.fromEntries(
                  Object.entries(answers).map(([id, answer]) => [
                    id,
                    { answers: [answer] },
                  ]),
                ),
              })
            }
          >
            {copy.sendAnswer}
          </button>
        </div>
      ) : approval.method === "item/permissions/requestApproval" ? (
        <p className="approval-note">{copy.permissionInCodex}</p>
      ) : (
        <div className="approval-actions">
          {allows("decline") ? (
            <button
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => respond({ decision: "decline" })}
            >
              {copy.decline}
            </button>
          ) : null}
          {allows("cancel") ? (
            <button
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => respond({ decision: "cancel" })}
            >
              {copy.cancelTask}
            </button>
          ) : null}
          {allows("accept") ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => respond({ decision: "accept" })}
            >
              {copy.approveOnce}
            </button>
          ) : null}
          {allows("acceptForSession") ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => respond({ decision: "acceptForSession" })}
            >
              {copy.approveSession}
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

export function AgentOffice() {
  const locale = useSyncExternalStore(
    subscribeLocale,
    localeSnapshot,
    localeServerSnapshot,
  );
  const [state, setState] = useState<OfficeState>(emptyState);
  const [selectedId, setSelectedId] = useState("chief");
  const [commandText, setCommandText] = useState("");
  const [commandSending, setCommandSending] = useState(false);
  const [commandResult, setCommandResult] = useState("");
  const [models, setModels] = useState<CodexModel[]>([]);
  const [modelChanging, setModelChanging] = useState(false);
  const [modelResult, setModelResult] = useState("");
  const [leisureActivities, setLeisureActivities] = useState<
    Record<string, LeisureActivity>
  >({});
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedBubbles, setDismissedBubbles] = useState<
    Record<string, string>
  >({});
  const [now, setNow] = useState(() => new Date());
  const agentsRef = useRef<AgentRecord[]>([]);
  const copy = uiCopy[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function changeLocale(nextLocale: Locale) {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT));
    setCommandResult("");
  }

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${bridgeUrl()}/api/state`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge ${response.status}`);
      setState((await response.json()) as OfficeState);
      setNotice(null);
    } catch {
      setNotice(uiCopy[locale].waitingBridge);
    }
  }, [locale]);

  const refreshModels = useCallback(async () => {
    try {
      const response = await fetch(`${bridgeUrl()}/api/models`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`models ${response.status}`);
      const result = (await response.json()) as { data?: CodexModel[] };
      setModels((result.data ?? []).filter((model) => !model.id.startsWith("test")));
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    agentsRef.current = state.agents;
  }, [state.agents]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const initialModelRefresh = window.setTimeout(() => void refreshModels(), 0);
    const timer = window.setInterval(() => {
      setNow(new Date());
      void refresh();
    }, 10_000);
    const events = new EventSource(`${bridgeUrl()}/api/events`);
    const handleEvent = () => void refresh();
    events.addEventListener("office-event", handleEvent);
    events.addEventListener("approval", handleEvent);
    events.addEventListener("movement", handleEvent);
    events.addEventListener("refresh", handleEvent);
    events.onerror = () => setNotice(uiCopy[locale].reconnecting);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearTimeout(initialModelRefresh);
      window.clearInterval(timer);
      events.close();
    };
  }, [locale, refresh, refreshModels]);

  const selected =
    state.agents.find((agent) => agent.id === selectedId) ?? state.agents[0];
  const activeWorkers = state.workers.filter(
    (worker) => worker.status === "working" || worker.status === "waiting",
  );
  const totalUsage = state.agents.reduce(
    (sum, agent) => sum + agent.usage.totalTokens,
    0,
  );
  const apiEquivalent = state.agents.reduce(
    (summary, agent) => {
      const cost = estimateStandardApiCost(agent.usage, agent.model);
      if (cost === null) summary.unpricedAgents += 1;
      else summary.cost += cost;
      return summary;
    },
    { cost: 0, unpricedAgents: 0 },
  );
  const selectedApiEstimate = selected
    ? estimateStandardApiCost(selected.usage, selected.model)
    : null;
  const rateLimit = getRateLimit(state.account.rateLimits);
  const idleAgentKey = state.agents
    .filter((agent) => agent.status === "idle")
    .map((agent) => agent.id)
    .join("|");
  useEffect(() => {
    const resetTimer = window.setTimeout(() => setLeisureActivities({}), 0);
    let waitingTimer: number | undefined;
    let activityTimer: number | undefined;
    let cancelled = false;

    const scheduleNext = () => {
      waitingTimer = window.setTimeout(() => {
        if (cancelled) return;
        const idleAgents = agentsRef.current.filter(
          (agent) => agent.status === "idle",
        );
        if (!idleAgents.length || secureRandomUnit() < 0.35) {
          scheduleNext();
          return;
        }
        setLeisureActivities(createRandomLeisureActivities(idleAgents, locale));
        activityTimer = window.setTimeout(() => {
          setLeisureActivities({});
          if (!cancelled) scheduleNext();
        }, randomBetween(12_000, 28_000));
      }, randomBetween(90_000, 300_000));
    };

    if (idleAgentKey) scheduleNext();
    return () => {
      cancelled = true;
      window.clearTimeout(resetTimer);
      if (waitingTimer) window.clearTimeout(waitingTimer);
      if (activityTimer) window.clearTimeout(activityTimer);
    };
  }, [idleAgentKey, locale]);
  const latestWhiteboardEvent = state.events.find(
    (event) => event.type === "command_center.called",
  );
  const latestWhiteboardPayload = latestWhiteboardEvent?.payload as {
    text?: unknown;
    targetAgentId?: unknown;
  } | null;
  const latestWhiteboardAgent = state.agents.find(
    (agent) => agent.id === latestWhiteboardPayload?.targetAgentId,
  );
  const latestWhiteboardText =
    typeof latestWhiteboardPayload?.text === "string"
      ? latestWhiteboardPayload.text
      : copy.boardEmpty;
  const selectedReportDetail = useMemo(() => {
    const event = state.events.find(
      (item) =>
        item.agentId === selected?.id && item.type === "agent.report_detail",
    );
    const payload = event?.payload as { text?: unknown } | null;
    return typeof payload?.text === "string" ? payload.text : "";
  }, [selected?.id, state.events]);
  const recentEvents = useMemo(
    () =>
      state.events
        .filter(
          (event) =>
            event.type !== "codex.stderr" &&
            event.type !== "agent.report_detail",
        )
        .slice(0, 28),
    [state.events],
  );

  async function post(path: string, body: unknown) {
    const response = await fetch(`${bridgeUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? copy.requestFailed);
    await refresh();
    return result;
  }

  function insertMention(agent: AgentRecord) {
    setCommandText((current) => {
      const withoutPreviousRole = current
        .replace(
          /@(CHIEF|PM|ENGINEER|FINANCE|DISPATCH|RESEARCH|DESIGN|QA)\b\s*/gi,
          "",
        )
        .trimStart();
      return `@${agent.shortRole} ${withoutPreviousRole}`;
    });
  }

  async function submitCommand(event: FormEvent) {
    event.preventDefault();
    const text = commandText.trim();
    if (!text) return;
    setCommandSending(true);
    try {
      const result = (await post("/api/dispatch", { text })) as {
        recipients: Array<{ id: string; name: string; shortRole: string }>;
        defaultedToChief: boolean;
        notionUrl: string | null;
      };
      const called = result.recipients.map((agent) => agent.shortRole).join(", ");
      setCommandResult(
        result.notionUrl
          ? `${called} ${copy.notionSaved}`
          : `${called} ${copy.taskStarted}`,
      );
      if (result.recipients[0]) {
        const recipient = state.agents.find(
          (agent) => agent.id === result.recipients[0].id,
        );
        if (recipient?.lastMessage) {
          setDismissedBubbles((current) => ({
            ...current,
            [recipient.id]: recipient.lastMessage,
          }));
        }
        setSelectedId(result.recipients[0].id);
      }
      setCommandText("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setCommandSending(false);
    }
  }

  async function interruptAgent() {
    if (!selected) return;
    try {
      await post(`/api/agents/${selected.id}/interrupt`, {});
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function changeAgentModel(model: string) {
    if (!selected || model === selected.model) return;
    setModelChanging(true);
    setModelResult("");
    try {
      await post(`/api/agents/${selected.id}/model`, { model });
      const modelName = models.find((item) => item.id === model)?.displayName ?? model;
      setModelResult(`${modelName}${copy.modelChanged}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setModelChanging(false);
    }
  }

  const clock = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);

  return (
    <main className="office-shell" data-period={getDayPeriod(now)}>
      <header className="office-header">
        <div className="brand-block">
          <span className="brand-mark">AO</span>
          <div>
            <h1>AGENT OFFICE</h1>
            <p>LOCAL CODEX CONTROL · MAC MINI</p>
          </div>
        </div>
        <div className="header-status">
          <div className="language-toggle" role="group" aria-label={copy.language}>
            <button
              type="button"
              className={locale === "ko" ? "is-active" : ""}
              aria-pressed={locale === "ko"}
              onClick={() => changeLocale("ko")}
            >
              KO
            </button>
            <button
              type="button"
              className={locale === "en" ? "is-active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => changeLocale("en")}
            >
              EN
            </button>
          </div>
          <span
            className={`connection-pill discord-pill ${state.discord.connected ? "is-connected" : ""}`}
            title={state.discord.error ?? state.discord.botName ?? copy.discordWaiting}
          >
            <i />
            {state.discord.connected ? "DISCORD LIVE" : state.discord.configured ? "DISCORD WAIT" : "DISCORD OFF"}
          </span>
          {state.notion.databaseUrl ? (
            <a
              className={`connection-pill notion-pill ${state.notion.connected ? "is-connected" : ""}`}
              href={state.notion.databaseUrl}
              target="_blank"
              rel="noreferrer"
              title={copy.openNotion}
            >
              <i />
              NOTION SYNC
            </a>
          ) : (
            <span
              className={`connection-pill notion-pill ${state.notion.connected ? "is-connected" : ""}`}
              title={state.notion.error ?? copy.notionWaiting}
            >
              <i />
              {state.notion.configured ? "NOTION WAIT" : "NOTION OFF"}
            </span>
          )}
          <span
            className={`connection-pill ${state.account.connected ? "is-connected" : ""}`}
          >
            <i />
            {state.account.connected ? "CHATGPT AUTH" : "CONNECTING"}
          </span>
          <time>{clock}</time>
        </div>
      </header>

      <section className="metrics-row" aria-label={copy.operations}>
        <Metric
          label={copy.residentSessions}
          value={`${state.agents.filter((agent) => agent.status !== "offline").length}/${state.agents.length}`}
          note={`${copy.allCodexThreads} ${state.threadCount}`}
          tone={state.account.connected ? "green" : "red"}
        />
        <Metric
          label={copy.dispatchedWorkers}
          value={activeWorkers.length}
          note={`${copy.cumulative} ${state.workers.length}`}
        />
        <Metric
          label={copy.pendingApprovals}
          value={state.approvals.length}
          note={copy.userCheckRequired}
          tone={state.approvals.length ? "amber" : "plain"}
        />
        <Metric
          label={copy.tokenUsage}
          value={formatNumber(totalUsage, locale)}
          note={copy.monitoredSessions}
        />
        <Metric
          label={copy.apiEquivalent}
          value={formatUsd(apiEquivalent.cost)}
          note={
            apiEquivalent.unpricedAgents
              ? `${copy.standardPriceExcluded} ${apiEquivalent.unpricedAgents}`
              : copy.standardPriceCached
          }
        />
        <Metric
          label={rateLimit?.limitName ?? copy.codexLimit}
          value={`${Math.round(rateLimit?.primary?.usedPercent ?? 0)}%`}
          note={String(state.account.planType ?? "ChatGPT").toUpperCase()}
          tone={(rateLimit?.primary?.usedPercent ?? 0) > 80 ? "red" : "plain"}
        />
      </section>

      {notice ? <div className="system-notice">{notice}</div> : null}

      <section className="workspace-grid">
        <div className="pixel-office-panel">
          <div className="panel-titlebar">
            <div>
              <span>LIVE FLOOR</span>
              <strong>{copy.officeTitle}</strong>
            </div>
            <div className="floor-legend">
              <span><i className="status-dot tone-green" />{copy.idle}</span>
              <span><i className="status-dot tone-blue" />{copy.work}</span>
              <span><i className="status-dot tone-amber" />{copy.review}</span>
            </div>
          </div>
          <div className="office-stage">
            <div className="skyline" aria-hidden="true">
              <i className="building b1" />
              <i className="building b2" />
              <i className="building b3" />
              <i className="building b4" />
              <i className="building b5" />
              <i className="building b6" />
              <i className="star s1" />
              <i className="star s2" />
              <i className="star s3" />
            </div>
            <div className="floor-grid" aria-hidden="true" />
            <div className="office-marquee" aria-hidden="true">
              <i />
              <span>AGENT OPS · ALWAYS ON</span>
              <i />
            </div>
            <div className="office-clock" aria-hidden="true"><i /></div>
            <div className="ceiling-light light-left" aria-hidden="true" />
            <div className="ceiling-light light-center" aria-hidden="true" />
            <div className="ceiling-light light-right" aria-hidden="true" />
            <section className="command-whiteboard" aria-label={copy.commandBoard}>
              <div className="whiteboard-heading">
                <span>COMMAND BOARD</span>
                <i className={state.account.connected ? "online" : ""} />
              </div>
              <div className="whiteboard-task-meta">
                <span>
                  @{latestWhiteboardAgent?.shortRole ?? "READY"}
                </span>
                <time>{formatTime(latestWhiteboardEvent?.createdAt ?? null, locale)}</time>
              </div>
              <p className="whiteboard-note">{latestWhiteboardText}</p>
              <small>
                {latestWhiteboardAgent
                  ? `${agentDisplayName(latestWhiteboardAgent, locale)} · ${statusLabels[locale][latestWhiteboardAgent.status]}`
                  : copy.attachNewTask}
              </small>
            </section>
            <div className="meeting-rug" aria-hidden="true" />
            <div className="coffee-zone" aria-hidden="true">
              <span>COFFEE</span>
              <i className="coffee-machine" />
              <i className="coffee-couch" />
            </div>
            <div className="meeting-table" aria-hidden="true">
              <span>SYNC TABLE</span>
              <i />
            </div>
            <div className="approval-zone" aria-hidden="true">
              <span>APPROVAL</span>
              <i />
            </div>
            <div className="server-rack" aria-hidden="true">
              <span>LOCAL CORE</span>
              <i /><i /><i />
            </div>
            <div className="pixel-plant plant-left" aria-hidden="true">
              <i /><b />
            </div>
            <div className="pixel-plant plant-right" aria-hidden="true">
              <i /><b />
            </div>
            <div className="supply-shelf" aria-hidden="true">
              <i /><i /><i />
            </div>
            {state.agents.map((agent) => (
              <Desk key={`desk-${agent.id}`} agent={agent} />
            ))}
            {state.agents.map((agent, index) => {
              const movement = state.movements.find(
                (item) => item.agentId === agent.id,
              );
              const speaking = !movement && spokeRecently(state, agent.id, now);
              return (
                <PixelAgent
                  key={agent.id}
                  agent={agent}
                  agents={state.agents}
                  locale={locale}
                  movement={movement}
                  leisure={
                    agent.status === "idle" && !movement && !speaking
                      ? leisureActivities[agent.id]
                      : undefined
                  }
                  speaking={speaking}
                  dismissed={dismissedBubbles[agent.id] === agent.lastMessage}
                  index={index}
                  selected={selected?.id === agent.id}
                  onSelect={() => setSelectedId(agent.id)}
                  onDismiss={() =>
                    setDismissedBubbles((current) => ({
                      ...current,
                      [agent.id]: agent.lastMessage,
                    }))
                  }
                />
              );
            })}
            {activeWorkers.map((worker, index) => (
              <PixelWorker
                key={worker.threadId}
                worker={worker}
                parent={state.agents.find(
                  (agent) => agent.id === worker.parentAgentId,
                )}
                index={index}
              />
            ))}
          </div>
        </div>

        <aside className="agent-inspector">
          {selected ? (
            <>
              <div className="inspector-head">
                <div
                  className="mini-avatar"
                  style={{ "--agent-color": selected.color } as OfficeStyle}
                >
                  <span />
                </div>
                <div>
                  <span>{selected.shortRole}</span>
                  <h2>{agentDisplayName(selected, locale)}</h2>
                  <p>{agentDisplayRole(selected, locale)}</p>
                </div>
                <i
                  className={`status-dot tone-${statusMeta[selected.status].tone}`}
                />
              </div>

              <div className="agent-runtime">
                <div>
                  <span>{copy.status}</span>
                  <strong>{statusLabels[locale][selected.status]}</strong>
                </div>
                <div>
                  <span>{copy.currentActivity}</span>
                  <strong>{translateActivity(selected.activity, locale)}</strong>
                </div>
                <div>
                  <span>{copy.lastEvent}</span>
                  <strong>{formatTime(selected.lastEventAt, locale)}</strong>
                </div>
                <div>
                  <span>{copy.permissions}</span>
                  <strong>{selected.sandbox}</strong>
                </div>
              </div>

              <div className="model-setting">
                <div>
                  <label htmlFor="agent-model">MODEL</label>
                  <small>{copy.modelHelp}</small>
                </div>
                <select
                  id="agent-model"
                  value={selected.model ?? ""}
                  disabled={modelChanging || Boolean(selected.activeTurnId) || !models.length}
                  onChange={(event) => void changeAgentModel(event.target.value)}
                >
                  {selected.model && !models.some((model) => model.id === selected.model) ? (
                    <option value={selected.model}>{selected.model}</option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}{model.isDefault ? ` · ${copy.defaultModel}` : ""}
                    </option>
                  ))}
                </select>
                <p>
                  {selected.activeTurnId
                    ? copy.modelBusy
                    : modelResult || models.find((model) => model.id === selected.model)?.description || selected.model}
                </p>
              </div>

              <div className="usage-block">
                <div className="usage-heading">
                  <span>THREAD USAGE</span>
                  <strong>{formatNumber(selected.usage.totalTokens, locale)}</strong>
                </div>
                <div className="usage-track">
                  <i
                    style={{
                      width: `${Math.min(100, (selected.usage.outputTokens / Math.max(1, selected.usage.totalTokens)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="usage-legend">
                  <span>{copy.input} {formatNumber(selected.usage.inputTokens, locale)}</span>
                  <span>{copy.output} {formatNumber(selected.usage.outputTokens, locale)}</span>
                  <span>{copy.cache} {formatNumber(selected.usage.cachedInputTokens, locale)}</span>
                </div>
                <small className="usage-cost">
                  {copy.apiEquivalentShort} {selectedApiEstimate === null ? copy.unavailablePrice : formatUsd(selectedApiEstimate)}
                </small>
              </div>

              <div className="last-message">
                <span>{copy.latestResponse}</span>
                <p>{selected.lastMessage || copy.noResponse}</p>
              </div>

              {selectedReportDetail ? (
                <details className="report-details">
                  <summary>
                    <span>{copy.taskDetails}</span>
                    <small>{copy.taskDetailsHint}</small>
                  </summary>
                  <p>{selectedReportDetail}</p>
                </details>
              ) : null}

              <form className="agent-message-form command-entry-form" onSubmit={submitCommand}>
                <label htmlFor="whiteboard-command">{copy.attachToBoard}</label>
                <div className="mention-chips" aria-label={copy.selectAssignee}>
                  {state.agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => insertMention(agent)}
                    >
                      @{agent.shortRole}
                    </button>
                  ))}
                </div>
                <textarea
                  id="whiteboard-command"
                  value={commandText}
                  onChange={(event) => setCommandText(event.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder={copy.commandPlaceholder}
                  aria-keyshortcuts="Enter Shift+Enter"
                  rows={4}
                />
                <div className="command-entry-actions">
                  {selected.activeTurnId ? (
                    <button
                      type="button"
                      className="button-danger"
                      onClick={interruptAgent}
                    >
                      {copy.stop}
                    </button>
                  ) : <span />}
                  <button type="submit" disabled={commandSending || !commandText.trim()}>
                    {commandSending ? copy.attaching : copy.attach}
                  </button>
                </div>
                <small>{commandResult || copy.commandSequence}</small>
              </form>
            </>
          ) : (
            <div className="empty-inspector">{copy.selectAgent}</div>
          )}
        </aside>
      </section>

      <section className="operations-grid">
        <div className="event-console">
          <div className="section-heading">
            <div>
              <span>EVENT STREAM</span>
              <h2>{copy.liveActivity}</h2>
            </div>
            <small>{recentEvents.length} events</small>
          </div>
          <div className="event-list">
            {recentEvents.map((event) => {
              const agent = state.agents.find((item) => item.id === event.agentId);
              return (
                <article key={event.id}>
                  <time>{formatTime(event.createdAt, locale)}</time>
                  <i
                    style={{ background: agent?.color ?? "#667085" }}
                    aria-hidden="true"
                  />
                  <div>
                    <span>{agent ? agentDisplayName(agent, locale) : "SYSTEM"}</span>
                    <p>{event.summary}</p>
                  </div>
                  <code>{event.type}</code>
                </article>
              );
            })}
          </div>
        </div>

        <div className="approval-console">
          <div className="section-heading">
            <div>
              <span>HUMAN GATE</span>
              <h2>{copy.approvalsAndQuestions}</h2>
            </div>
            <small>{state.approvals.length} pending</small>
          </div>
          <div className="approval-list">
            {state.approvals.length ? (
              state.approvals.map((approval) => (
                <ApprovalCard
                  key={approval.requestId}
                  approval={approval}
                  locale={locale}
                  onRespond={(item, body) =>
                    post(`/api/approvals/${item.requestId}/respond`, body)
                  }
                />
              ))
            ) : (
              <div className="approval-empty">
                <i>✓</i>
                <strong>{copy.noApprovals}</strong>
                <span>{copy.approvalSafety}</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
