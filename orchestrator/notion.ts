export interface NotionConnectionState {
  configured: boolean;
  connected: boolean;
  databaseUrl: string | null;
  error: string | null;
}

export interface NotionDatabaseReference {
  databaseId: string;
  dataSourceId: string;
  databaseUrl: string;
}

export interface NotionTaskInput {
  title: string;
  request: string;
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  startedAt: string;
}

export interface NotionTaskReference {
  pageId: string;
  pageUrl: string;
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

function plainText(value: string, max = 12_000) {
  return value.replace(/\0/g, "").trim().slice(0, max);
}

function richText(value: string) {
  const clean = plainText(value);
  if (!clean) return [];
  const chunks = clean.match(/[\s\S]{1,1900}/g) ?? [];
  return chunks.map((content) => ({
    type: "text",
    text: { content },
  }));
}

function databaseReference(value: unknown): NotionDatabaseReference | null {
  if (!value || typeof value !== "object") return null;
  const database = value as {
    id?: unknown;
    url?: unknown;
    data_sources?: Array<{ id?: unknown }>;
    dataSources?: Array<{ id?: unknown }>;
  };
  const databaseId = typeof database.id === "string" ? database.id : "";
  const databaseUrl = typeof database.url === "string" ? database.url : "";
  const sources = database.data_sources ?? database.dataSources ?? [];
  const dataSourceId = sources.find(
    (source) => typeof source?.id === "string",
  )?.id;
  if (!databaseId || !databaseUrl || typeof dataSourceId !== "string") {
    return null;
  }
  return { databaseId, dataSourceId, databaseUrl };
}

export class NotionSync {
  private reference: NotionDatabaseReference | null = null;
  private state: NotionConnectionState;
  private initializing: Promise<NotionDatabaseReference | null> | null = null;

  constructor(private readonly token: string | undefined) {
    this.state = {
      configured: Boolean(token),
      connected: false,
      databaseUrl: null,
      error: null,
    };
  }

  getState(): NotionConnectionState {
    return { ...this.state };
  }

  async initialize(
    saved: Partial<NotionDatabaseReference> | null,
  ): Promise<NotionDatabaseReference | null> {
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce(saved).finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async initializeOnce(
    saved: Partial<NotionDatabaseReference> | null,
  ): Promise<NotionDatabaseReference | null> {
    if (!this.token) return null;
    try {
      await this.request("/users/me");
      let reference: NotionDatabaseReference | null = null;
      if (saved?.databaseId && saved?.dataSourceId) {
        const database = await this.request(`/databases/${saved.databaseId}`);
        reference = databaseReference(database) ?? {
          databaseId: saved.databaseId,
          dataSourceId: saved.dataSourceId,
          databaseUrl:
            typeof saved.databaseUrl === "string" ? saved.databaseUrl : "",
        };
      }
      if (!reference) reference = await this.createDatabase();
      this.reference = reference;
      this.state = {
        configured: true,
        connected: true,
        databaseUrl: reference.databaseUrl || null,
        error: null,
      };
      return reference;
    } catch (error) {
      this.reference = null;
      this.state = {
        configured: true,
        connected: false,
        databaseUrl: null,
        error: error instanceof Error ? error.message : String(error),
      };
      return null;
    }
  }

  private async createDatabase() {
    const created = await this.request("/databases", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "workspace", workspace: true },
        title: [{ type: "text", text: { content: "Agent Office 업무" } }],
        description: [
          {
            type: "text",
            text: {
              content:
                "화이트보드에서 시작한 업무와 완료 결과가 자동으로 기록됩니다.",
            },
          },
        ],
        icon: { type: "emoji", emoji: "🏢" },
        is_inline: false,
        initial_data_source: {
          properties: {
            업무: { title: {} },
            상태: {
              select: {
                options: [
                  { name: "진행 중", color: "blue" },
                  { name: "완료", color: "green" },
                  { name: "실패", color: "red" },
                ],
              },
            },
            담당: {
              select: {
                options: [
                  { name: "CHIEF", color: "red" },
                  { name: "PM", color: "blue" },
                  { name: "ENGINEER", color: "yellow" },
                  { name: "FINANCE", color: "green" },
                  { name: "DISPATCH", color: "purple" },
                  { name: "RESEARCH", color: "gray" },
                  { name: "DESIGN", color: "pink" },
                  { name: "QA", color: "orange" },
                ],
              },
            },
            요청: { rich_text: {} },
            결과: { rich_text: {} },
            시작: { date: {} },
            완료일: { date: {} },
            Thread: { rich_text: {} },
          },
        },
      }),
    });
    let reference = databaseReference(created);
    const databaseId =
      created && typeof created === "object" && typeof created.id === "string"
        ? created.id
        : "";
    if (!reference && databaseId) {
      reference = databaseReference(await this.request(`/databases/${databaseId}`));
    }
    if (!reference) {
      throw new Error("노션 업무 보드의 데이터 소스를 확인하지 못했습니다");
    }
    return reference;
  }

  async createTask(input: NotionTaskInput): Promise<NotionTaskReference | null> {
    if (!this.reference) return null;
    const page = await this.request("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: {
          type: "data_source_id",
          data_source_id: this.reference.dataSourceId,
        },
        properties: {
          업무: {
            title: richText(plainText(input.title, 160)),
          },
          상태: { select: { name: "진행 중" } },
          담당: { select: { name: input.agentId.toUpperCase() } },
          요청: { rich_text: richText(input.request) },
          시작: { date: { start: input.startedAt } },
          Thread: {
            rich_text: richText(
              [input.threadId, input.turnId].filter(Boolean).join(" / "),
            ),
          },
        },
      }),
    });
    if (
      !page ||
      typeof page !== "object" ||
      typeof page.id !== "string" ||
      typeof page.url !== "string"
    ) {
      throw new Error("노션 업무 페이지를 확인하지 못했습니다");
    }
    return { pageId: page.id, pageUrl: page.url };
  }

  async completeTask(
    pageId: string,
    status: "완료" | "실패",
    result: string,
  ) {
    await this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          상태: { select: { name: status } },
          결과: { rich_text: richText(result) },
          완료일: { date: { start: new Date().toISOString() } },
        },
      }),
    });
  }

  private async request(path: string, init: RequestInit = {}) {
    if (!this.token) throw new Error("노션 토큰이 설정되지 않았습니다");
    const response = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json()) as {
      message?: unknown;
      [key: string]: unknown;
    };
    if (!response.ok) {
      const message =
        typeof body.message === "string" ? body.message : "요청이 거절됐습니다";
      throw new Error(`노션 연결 오류 (${response.status}): ${message}`);
    }
    return body;
  }
}
