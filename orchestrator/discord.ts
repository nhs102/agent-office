import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import {
  DiscordVoiceAssistant,
  type DiscordVoiceState,
  type VoiceCommandStage,
} from "./voice";
import {
  discordProjectTagNames,
  discordProjectThreadName,
} from "./discord-project";
import {
  detectOfficeLanguage,
  officeLanguageText,
} from "./language";

export interface DiscordConnectionState {
  configured: boolean;
  connected: boolean;
  botName: string | null;
  error: string | null;
  voice: DiscordVoiceState;
}

export interface DiscordCommandInput {
  agentId: string;
  command: string;
  channelId: string;
  messageId?: string;
  userId: string;
  source: "guild" | "mention" | "dm" | "voice" | "project";
  audience?: "single" | "everyone";
  voiceStage?: VoiceCommandStage;
  projectThreadId?: string;
  projectTitle?: string;
}

export interface DiscordCommandResult {
  shortRole: string;
  acknowledgement?: string;
}

interface DiscordDirectMessageBot {
  agentId: string;
  shortRole: string;
  token?: string;
  applicationId?: string;
}

interface DiscordConfiguration {
  token?: string;
  applicationId?: string;
  guildId?: string;
  channelId?: string;
  reportForumId?: string;
  allowedUserId?: string;
  messageContentEnabled?: boolean;
  voiceChannelId?: string;
  voiceTextChannelId?: string;
  voicePythonPath: string;
  voiceTranscriberScript: string;
  voiceWhisperModel: string;
  agents: Array<{ id: string; name: string; shortRole: string }>;
  directMessageBots: DiscordDirectMessageBot[];
}

function cleanError(error: unknown, secret?: string) {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, "[숨김]");
  return message.replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [숨김]").slice(0, 300);
}

export class DiscordBot {
  private readonly client: Client;
  private readonly directMessageClients = new Map<string, Client>();
  private readonly directMessageBotNames = new Map<string, string>();
  private readonly directMessageBotErrors = new Map<string, string>();
  private readonly typingTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly voiceAssistant: DiscordVoiceAssistant;
  private state: DiscordConnectionState;
  private started = false;

  constructor(
    private readonly configuration: DiscordConfiguration,
    private readonly onCommand: (
      input: DiscordCommandInput,
    ) => Promise<DiscordCommandResult>,
    private readonly onStateChange: () => void,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        ...(configuration.messageContentEnabled
          ? [GatewayIntentBits.MessageContent]
          : []),
      ],
    });
    this.voiceAssistant = new DiscordVoiceAssistant(
      this.client,
      {
        guildId: configuration.guildId,
        voiceChannelId: configuration.voiceChannelId,
        textChannelId:
          configuration.voiceTextChannelId ?? configuration.channelId,
        allowedUserId: configuration.allowedUserId,
        pythonPath: configuration.voicePythonPath,
        transcriberScript: configuration.voiceTranscriberScript,
        whisperModel: configuration.voiceWhisperModel,
      },
      ({ command, stage, channelId, userId }) =>
        this.onCommand({
          agentId: "chief",
          command,
          channelId,
          userId,
          source: "voice",
          voiceStage: stage,
        }),
      (voice) => {
        this.state = { ...this.state, voice };
        this.onStateChange();
      },
    );
    const configuredDirectMessageBots = configuration.directMessageBots.filter(
      (bot) => bot.token,
    );
    this.state = {
      configured: Boolean(
        (configuration.token &&
          configuration.applicationId &&
          configuration.guildId &&
          configuration.channelId) || configuredDirectMessageBots.length,
      ),
      connected: false,
      botName: null,
      error: null,
      voice: this.voiceAssistant.getState(),
    };
  }

  getState(): DiscordConnectionState {
    return { ...this.state };
  }

  private refreshState() {
    const configuredBots = this.configuration.directMessageBots.filter(
      (bot) => bot.token,
    );
    const directMessageReady = configuredBots.every((bot) =>
      this.directMessageClients.get(bot.agentId)?.isReady(),
    );
    const names = [
      this.client.user?.username,
      ...configuredBots.map((bot) => this.directMessageBotNames.get(bot.agentId)),
    ].filter((name): name is string => Boolean(name));
    const errors = [...this.directMessageBotErrors.entries()].map(
      ([agentId, error]) => `${agentId.toUpperCase()}: ${error}`,
    );
    this.state = {
      configured: this.state.configured,
      connected: this.client.isReady() && directMessageReady,
      botName: names.length ? names.join(" + ") : null,
      error: errors[0] ?? this.state.error,
      voice: this.voiceAssistant.getState(),
    };
    this.onStateChange();
  }

  private async startDirectMessageBot(bot: DiscordDirectMessageBot) {
    if (!bot.token) return;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.directMessageClients.set(bot.agentId, client);
    client.on(Events.MessageCreate, (message) => {
      if (message.guildId) {
        void this.handleGuildMention(bot, client, message);
      } else {
        void this.handleDirectMessage(bot, message);
      }
    });
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) {
        void this.handleApprovalButton(interaction);
      }
    });
    client.once(Events.ClientReady, (readyClient) => {
      this.directMessageBotNames.set(bot.agentId, readyClient.user.username);
      this.directMessageBotErrors.delete(bot.agentId);
      readyClient.user.setPresence({
        activities: [{ name: `${bot.shortRole} 업무 대기` }],
        status: "online",
      });
      this.refreshState();
    });
    client.on(Events.Error, (error) => {
      this.directMessageBotErrors.set(
        bot.agentId,
        cleanError(error, bot.token),
      );
      this.refreshState();
    });
    try {
      await client.login(bot.token);
    } catch (error) {
      this.directMessageBotErrors.set(
        bot.agentId,
        cleanError(error, bot.token),
      );
      this.refreshState();
    }
  }

  async start() {
    if (!this.state.configured || this.started) return;
    this.started = true;
    const { token, applicationId, guildId } = this.configuration;
    if (!token || !applicationId || !guildId) return;

    try {
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
        body: [
          {
            name: "office",
            description: "Agent Office 담당자에게 업무를 전달합니다",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "담당",
                description: "업무를 맡길 담당자",
                required: true,
                choices: this.configuration.agents.map((agent) => ({
                  name: `${agent.name} · ${agent.shortRole}`,
                  value: agent.id,
                })),
              },
              {
                type: ApplicationCommandOptionType.String,
                name: "명령",
                description: "처리할 업무나 질문",
                required: true,
                max_length: 1800,
              },
            ],
          },
          {
            name: "project",
            description: "새 프로젝트 포럼을 만들고 Agent Office 작업을 시작합니다",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "title",
                description: "Projects 포럼에 표시할 프로젝트 제목",
                required: true,
                max_length: 90,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: "task",
                description: "프로젝트에서 처리할 전체 요청",
                required: true,
                max_length: 1800,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: "owner",
                description: "첫 담당자 · 기본값 CHIEF",
                required: false,
                choices: this.configuration.agents.map((agent) => ({
                  name: `${agent.name} · ${agent.shortRole}`,
                  value: agent.id,
                })),
              },
            ],
          },
        ],
      });

      this.client.on(Events.InteractionCreate, (interaction) => {
        if (interaction.isButton()) {
          void this.handleApprovalButton(interaction);
          return;
        }
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName === "office") {
          void this.handleInteraction(interaction);
        } else if (interaction.commandName === "project") {
          void this.handleProjectInteraction(interaction);
        }
      });
      const chief = this.configuration.agents.find((agent) => agent.id === "chief");
      if (chief) {
        this.client.on(Events.MessageCreate, (message) => {
          void this.handleGuildMention(
            { agentId: chief.id, shortRole: chief.shortRole, token },
            this.client,
            message,
          );
        });
      }
      this.client.once(Events.ClientReady, (readyClient) => {
        this.state = { ...this.state, error: null };
        readyClient.user.setPresence({
          activities: [{ name: "Agent Office 관제" }],
          status: "online",
        });
        this.refreshState();
        void this.voiceAssistant.start();
      });
      this.client.on(Events.Error, (error) => {
        this.state = { ...this.state, error: cleanError(error, token) };
        this.onStateChange();
      });
      await this.client.login(token);
      await Promise.all(
        this.configuration.directMessageBots.map((bot) =>
          this.startDirectMessageBot(bot),
        ),
      );
      this.refreshState();
    } catch (error) {
      this.started = false;
      this.state = {
        ...this.state,
        connected: false,
        error: cleanError(error, token),
      };
      this.onStateChange();
    }
  }

  private async handleDirectMessage(
    bot: DiscordDirectMessageBot,
    message: Message,
  ) {
    if (message.author.bot || message.guildId) return;
    const allowedUserId = this.configuration.allowedUserId?.trim();
    if (!allowedUserId || message.author.id !== allowedUserId) {
      await message
        .reply({
          content: "이 봇은 등록된 Agent Office 사용자만 쓸 수 있어요.",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
      return;
    }
    const command = message.content.trim();
    if (!command) {
      await message
        .reply({
          content: "텍스트로 시킬 일을 적어주세요.",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
      return;
    }

    try {
      await message.react("👀").catch(() => undefined);
      this.keepTyping(message.channelId, bot.agentId, () =>
        "sendTyping" in message.channel
          ? message.channel.sendTyping()
          : Promise.resolve(),
      );
      const result = await this.onCommand({
        agentId: bot.agentId,
        command,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        source: "dm",
      });
      if (result.acknowledgement) {
        this.stopTyping(message.channelId, bot.agentId);
        await message.react("✅").catch(() => undefined);
        await message.reply({
          content: result.acknowledgement,
          allowedMentions: { repliedUser: false },
        });
      } else {
        await message.react("🛠️").catch(() => undefined);
      }
    } catch (error) {
      this.stopTyping(message.channelId, bot.agentId);
      await message.react("⚠️").catch(() => undefined);
      await message
        .reply({
          content: `앗, 처리하지 못했어요. ${cleanError(error, bot.token)}`,
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
    }
  }

  private firstMentionedClientId(message: Message) {
    const clients = [this.client, ...this.directMessageClients.values()]
      .filter((client) => client.user && message.mentions.users.has(client.user.id))
      .map((client) => {
        const id = client.user!.id;
        const regular = message.content.indexOf(`<@${id}>`);
        const nickname = message.content.indexOf(`<@!${id}>`);
        const positions = [regular, nickname].filter((position) => position >= 0);
        return { id, position: positions.length ? Math.min(...positions) : Infinity };
      })
      .sort((left, right) => left.position - right.position);
    return clients[0]?.id ?? null;
  }

  private async handleGuildMention(
    bot: DiscordDirectMessageBot,
    client: Client,
    message: Message,
  ) {
    const directlyMentioned = Boolean(
      client.user && message.mentions.users.has(client.user.id),
    );
    const everyoneCall = Boolean(
      message.mentions.everyone &&
        (directlyMentioned ||
          (bot.agentId === "chief" &&
            this.configuration.messageContentEnabled)),
    );
    if (
      message.author.bot ||
      !message.guildId ||
      message.guildId !== this.configuration.guildId ||
      !client.user ||
      (!directlyMentioned && !everyoneCall) ||
      (directlyMentioned &&
        this.firstMentionedClientId(message) !== client.user.id)
    ) {
      return;
    }
    const allowedUserId = this.configuration.allowedUserId?.trim();
    if (!allowedUserId || message.author.id !== allowedUserId) {
      await message
        .reply({
          content: "이 봇은 등록된 Agent Office 사용자만 쓸 수 있어요.",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
      return;
    }
    const command = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .replace(/@(everyone|here)\b/gi, "")
      .trim();
    if (!command) {
      await message
        .reply({
          content: "멘션 뒤에 시킬 일을 적어주세요.",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
      return;
    }

    try {
      const targetAgentId = everyoneCall ? "chief" : bot.agentId;
      await message.react("👀").catch(() => undefined);
      this.keepTyping(message.channelId, targetAgentId, () =>
        "sendTyping" in message.channel
          ? message.channel.sendTyping()
          : Promise.resolve(),
      );
      const result = await this.onCommand({
        agentId: targetAgentId,
        command,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        source: "mention",
        audience: everyoneCall ? "everyone" : "single",
      });
      if (result.acknowledgement) {
        this.stopTyping(message.channelId, targetAgentId);
        await message.react("✅").catch(() => undefined);
        await message.reply({
          content: result.acknowledgement,
          allowedMentions: { repliedUser: false },
        });
      } else {
        await message.react("🛠️").catch(() => undefined);
      }
    } catch (error) {
      this.stopTyping(
        message.channelId,
        everyoneCall ? "chief" : bot.agentId,
      );
      await message.react("⚠️").catch(() => undefined);
      await message
        .reply({
          content: `앗, 처리하지 못했어요. ${cleanError(error, bot.token)}`,
          allowedMentions: { repliedUser: false },
        })
        .catch(() => undefined);
    }
  }

  private keepTyping(
    channelId: string,
    agentId: string,
    sendTyping: () => Promise<unknown>,
  ) {
    const key = `${channelId}:${agentId}`;
    const previous = this.typingTimers.get(key);
    if (previous) clearInterval(previous);
    void sendTyping().catch(() => undefined);
    const timer = setInterval(() => {
      void sendTyping().catch(() => undefined);
    }, 8_000);
    this.typingTimers.set(key, timer);
  }

  private stopTyping(channelId: string, agentId: string) {
    const key = `${channelId}:${agentId}`;
    const timer = this.typingTimers.get(key);
    if (timer) clearInterval(timer);
    this.typingTimers.delete(key);
  }

  async reactToMessage(
    channelId: string,
    messageId: string | null | undefined,
    agentId: string,
    emoji: "✅" | "⚠️",
  ) {
    if (!messageId) return false;
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("messages" in channel)) continue;
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
        return true;
      } catch {
        // 다른 역할 봇이나 메인 봇으로 다시 시도합니다.
      }
    }
    return false;
  }

  private async handleApprovalButton(interaction: ButtonInteraction) {
    const voiceMatch = interaction.customId.match(
      /^office:voice:(questions|summary|execute|cancel)$/,
    );
    const approvalMatch = interaction.customId.match(
      /^office:approval:([a-z0-9_-]+):(accept|decline)$/,
    );
    if (!voiceMatch && !approvalMatch) return;
    const allowedUserId = this.configuration.allowedUserId?.trim();
    if (!allowedUserId || interaction.user.id !== allowedUserId) {
      await interaction.reply({
        content: "등록된 Agent Office 사용자만 승인할 수 있어요.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      if (voiceMatch) {
        const message = await this.voiceAssistant.handleControl(
          voiceMatch[1] as "questions" | "summary" | "execute" | "cancel",
        );
        await interaction.followUp({ content: message, ephemeral: true });
        return;
      }
      const [, agentId, action] = approvalMatch!;
      const result = await this.onCommand({
        agentId,
        command: action === "accept" ? "승인" : "거절",
        channelId: interaction.channelId,
        userId: interaction.user.id,
        source: interaction.guildId ? "mention" : "dm",
      });
      await interaction.editReply({ components: [] });
      await interaction.followUp({
        content:
          result.acknowledgement ??
          (action === "accept" ? "승인했어요." : "거절했어요."),
        ephemeral: true,
      });
    } catch (error) {
      await interaction.followUp({
        content: `앗, 처리하지 못했어요. ${cleanError(error)}`,
        ephemeral: true,
      });
    }
  }

  private async createProjectThread(
    title: string,
    ownerRole: string,
    task: string,
  ) {
    const reportForumId = this.configuration.reportForumId?.trim();
    if (!reportForumId) {
      throw new Error("DISCORD_REPORT_FORUM_ID가 설정되지 않았습니다");
    }
    const channel = await this.client.channels.fetch(reportForumId);
    if (!channel?.isThreadOnly()) {
      throw new Error("DISCORD_REPORT_FORUM_ID가 포럼 채널이 아닙니다");
    }
    const tagNames = discordProjectTagNames("working");
    const tag = channel.availableTags.find((candidate) =>
      tagNames.includes(candidate.name.trim().toLocaleLowerCase()),
    );
    const cleanTask = task.trim().slice(0, 1_700);
    const responseLanguage = detectOfficeLanguage(task);
    const thread = await channel.threads.create({
      name: discordProjectThreadName(title, "working"),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      appliedTags: tag ? [tag.id] : undefined,
      message: {
        content: [
          "🚀 **PROJECT STARTED**",
          `**Owner:** ${ownerRole}`,
          `**Request**\n${cleanTask}`,
          officeLanguageText(
            responseLanguage,
            "진행 보고와 승인 요청, 최종 결과가 이 글에 계속 기록됩니다.",
            "Progress updates, approval requests, and the final result will be posted in this thread.",
          ),
          `<t:${Math.floor(Date.now() / 1000)}:f>`,
        ].join("\n\n"),
        allowedMentions: { parse: [] },
      },
    });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    return {
      id: thread.id,
      starterMessageId: starter?.id,
      url: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
    };
  }

  async finishProjectThread(
    threadId: string,
    status: "complete" | "failed",
  ) {
    const candidates = [this.client, ...this.directMessageClients.values()].filter(
      (client): client is Client => Boolean(client?.isReady()),
    );
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel?.isThread() || !channel.parent?.isThreadOnly()) continue;
        const parent = channel.parent;
        const allStatusNames = new Set([
          ...discordProjectTagNames("working"),
          ...discordProjectTagNames("complete"),
          ...discordProjectTagNames("failed"),
        ]);
        const statusTagIds = new Set(
          parent.availableTags
            .filter((tag) =>
              allStatusNames.has(tag.name.trim().toLocaleLowerCase()),
            )
            .map((tag) => tag.id),
        );
        const targetNames = discordProjectTagNames(status);
        const targetTag = parent.availableTags.find((tag) =>
          targetNames.includes(tag.name.trim().toLocaleLowerCase()),
        );
        const preservedTags = channel.appliedTags.filter(
          (tagId) => !statusTagIds.has(tagId),
        );
        if (targetTag) preservedTags.push(targetTag.id);
        await channel.setAppliedTags(preservedTags);
        await channel.setName(discordProjectThreadName(channel.name, status));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("프로젝트 포럼 상태를 변경할 수 없습니다");
  }

  private async handleProjectInteraction(
    interaction: ChatInputCommandInteraction,
  ) {
    try {
      if (
        this.configuration.allowedUserId &&
        interaction.user.id !== this.configuration.allowedUserId
      ) {
        await interaction.reply({
          content: "등록된 Agent Office 사용자만 프로젝트를 시작할 수 있어요.",
          ephemeral: true,
        });
        return;
      }
      if (interaction.guildId !== this.configuration.guildId) {
        await interaction.reply({
          content: "등록된 Agent Office 서버가 아니에요.",
          ephemeral: true,
        });
        return;
      }
      if (interaction.channelId !== this.configuration.channelId) {
        await interaction.reply({
          content: "Agent Office 명령 채널에서 `/project`를 실행해주세요.",
          ephemeral: true,
        });
        return;
      }

      const title = interaction.options.getString("title", true).trim();
      const task = interaction.options.getString("task", true).trim();
      const ownerId = interaction.options.getString("owner") ?? "chief";
      const owner = this.configuration.agents.find(
        (agent) => agent.id === ownerId,
      );
      const responseLanguage = detectOfficeLanguage(task);
      if (!owner || !title || !task) {
        await interaction.reply({
          content: "프로젝트 제목과 요청을 확인해주세요.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      const project = await this.createProjectThread(
        title,
        owner.shortRole,
        task,
      );
      await interaction.editReply({
        content: officeLanguageText(
          responseLanguage,
          `🚀 **${title}** 프로젝트를 시작했어요.\n${project.url}`,
          `🚀 **${title}** project started.\n${project.url}`,
        ),
        allowedMentions: { parse: [] },
      });

      try {
        await this.onCommand({
          agentId: owner.id,
          command: task,
          channelId: project.id,
          messageId: project.starterMessageId,
          userId: interaction.user.id,
          source: "project",
          projectThreadId: project.id,
          projectTitle: title,
        });
      } catch (error) {
        await this.sendProgressUpdate(
          project.id,
          owner.id,
          owner.shortRole,
          "FAILED",
          officeLanguageText(
            responseLanguage,
            `프로젝트를 시작하지 못했어요. ${cleanError(error, this.configuration.token)}`,
            `The project could not be started. ${cleanError(error, this.configuration.token)}`,
          ),
          "⚠️",
        ).catch(() => undefined);
        await this.finishProjectThread(project.id, "failed").catch(
          () => undefined,
        );
        await interaction.followUp({
          content: "포럼 글은 만들었지만 Agent Office 작업 시작에 실패했어요.",
          ephemeral: true,
        });
      }
    } catch (error) {
      const message = `프로젝트를 시작하지 못했어요. ${cleanError(error, this.configuration.token)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => undefined);
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction) {
    try {
      if (
        this.configuration.allowedUserId &&
        interaction.user.id !== this.configuration.allowedUserId
      ) {
        await interaction.reply({
          content: "등록된 Agent Office 사용자만 명령할 수 있어요.",
          ephemeral: true,
        });
        return;
      }
      if (interaction.guildId !== this.configuration.guildId) {
        await interaction.reply({ content: "등록된 Agent Office 서버가 아니에요.", ephemeral: true });
        return;
      }
      if (interaction.channelId !== this.configuration.channelId) {
        await interaction.reply({ content: "Agent Office 명령 채널에서 불러주세요.", ephemeral: true });
        return;
      }
      const agentId = interaction.options.getString("담당", true) as DiscordCommandInput["agentId"];
      const command = interaction.options.getString("명령", true).trim();
      if (!command) {
        await interaction.reply({ content: "시킬 일을 적어주세요.", ephemeral: true });
        return;
      }
      await interaction.deferReply();
      const result = await this.onCommand({
        agentId,
        command,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        source: "guild",
      });
      await interaction.editReply(
        result.acknowledgement ??
          `${result.shortRole} 불렀어요. 끝나면 이 채널로 알려드릴게요.`,
      );
    } catch (error) {
      const message = `앗, 전달하지 못했어요. ${cleanError(error, this.configuration.token)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => undefined);
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
      }
    }
  }

  async sendResult(
    channelId: string,
    agentId: string,
    shortRole: string,
    status: "complete" | "failed",
    result: string,
    language: "ko" | "en" = "ko",
  ) {
    const clean = result.replace(/\s+/g, " ").trim().slice(0, 1700);
    const icon = status === "complete" ? "✅" : "⚠️";
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    this.stopTyping(channelId, agentId);
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) continue;
        await channel.send({
          content: clean
            ? `${icon} **${shortRole}** ${clean}`
            : `${icon} **${shortRole}** ${
                language === "en"
                  ? status === "complete"
                    ? "Done."
                    : "The work stopped."
                  : status === "complete"
                    ? "끝났어요."
                    : "작업이 멈췄어요."
              }`,
          allowedMentions: { parse: [] },
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 응답 채널에 답할 수 없습니다");
  }

  async sendApprovalNeeded(
    channelId: string,
    agentId: string,
    shortRole: string,
    summary: string,
    language: "ko" | "en" = "ko",
  ) {
    const clean = summary.replace(/\s+/g, " ").trim().slice(0, 500);
    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`office:approval:${agentId}:accept`)
        .setLabel(language === "en" ? "Approve" : "승인")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`office:approval:${agentId}:decline`)
        .setLabel(language === "en" ? "Decline" : "거절")
        .setStyle(ButtonStyle.Danger),
    );
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    this.stopTyping(channelId, agentId);
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) continue;
        await channel.send({
          content:
            language === "en"
              ? `⏸️ **${shortRole}** Approval needed: ${clean}`
              : `⏸️ **${shortRole}** ${clean} 승인이 필요해요.`,
          components: [actions],
          allowedMentions: { parse: [] },
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 승인 안내를 보낼 수 없습니다");
  }

  async sendDiscussionUpdate(
    channelId: string,
    agentId: string,
    shortRole: string,
    label: string,
    text: string,
    icon = "💬",
  ) {
    const clean = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 1700);
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) continue;
        const message = await channel.send({
          content: `${icon} **${shortRole} · ${label}**\n${clean}`,
          allowedMentions: { parse: [] },
        });
        return { id: message.id };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 회의 내용을 보낼 수 없습니다");
  }

  async sendHandoffUpdate(
    channelId: string,
    agentId: string,
    sourceRole: string,
    targetRole: string,
  ) {
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) continue;
        await channel.send({
          content: `🔄 **${sourceRole} → ${targetRole} · IN PROGRESS**`,
          allowedMentions: { parse: [] },
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 업무 전달 상태를 보낼 수 없습니다");
  }

  async sendProgressUpdate(
    channelId: string,
    agentId: string,
    shortRole: string,
    label: string,
    text: string,
    icon = "📍",
  ) {
    const clean = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 1_500);
    if (!clean) return;
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    let lastError: unknown = null;
    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) continue;
        await channel.send({
          content: `${icon} **${shortRole} · ${label}**\n${clean}`,
          allowedMentions: { parse: [] },
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 진행 상황을 보낼 수 없습니다");
  }

  finishDiscussion(channelId: string) {
    this.stopTyping(channelId, "chief");
  }

  async sendReport(
    agentId: string,
    shortRole: string,
    status: "complete" | "failed",
    result: string,
  ) {
    const reportForumId = this.configuration.reportForumId?.trim();
    if (!reportForumId) return null;

    const clean = result.replace(/\s+/g, " ").trim().slice(0, 1700);
    const icon = status === "complete" ? "✅" : "⚠️";
    const statusLabel = status === "complete" ? "완료" : "실패";
    const statusTagNames = status === "complete"
      ? ["완료", "completed", "complete", "done"]
      : ["실패", "failed", "failure", "paused", "중단"];
    const headline = clean
      .replace(/[*_`#>]/g, "")
      .trim()
      .slice(0, 70);
    const candidates = [
      this.directMessageClients.get(agentId),
      this.client,
    ].filter((client): client is Client => Boolean(client?.isReady()));
    let lastError: unknown = null;

    for (const client of candidates) {
      try {
        const channel = await client.channels.fetch(reportForumId);
        if (!channel?.isThreadOnly()) {
          throw new Error("DISCORD_REPORT_FORUM_ID가 포럼 채널이 아닙니다");
        }
        const matchingTag = channel.availableTags.find(
          (tag) => statusTagNames.includes(tag.name.trim().toLocaleLowerCase()),
        );
        const fallbackTag = channel.availableTags.find((tag) => !tag.moderated);
        const tag = matchingTag ?? fallbackTag;
        const thread = await channel.threads.create({
          name: `${icon} ${shortRole} · ${headline || "작업 결과"}`.slice(0, 100),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          appliedTags: tag ? [tag.id] : undefined,
          message: {
            content: [
              `**${shortRole} 작업 ${statusLabel}**`,
              clean || (status === "complete" ? "작업을 마쳤어요." : "작업이 멈췄어요."),
              `<t:${Math.floor(Date.now() / 1000)}:f>`,
            ].join("\n\n"),
            allowedMentions: { parse: [] },
          },
        });
        return {
          id: thread.id,
          url: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("디스코드 결과 포럼에 게시할 수 없습니다");
  }

  async stop() {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.voiceAssistant.stop(false);
    this.client.destroy();
    for (const client of this.directMessageClients.values()) client.destroy();
    this.directMessageClients.clear();
    this.directMessageBotNames.clear();
    this.state = { ...this.state, connected: false };
    this.started = false;
  }
}
