import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type Client,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";

export type VoiceSessionMode = "idle" | "dump" | "interview";
export type VoiceCommandStage = "direct" | "interview" | "execute";

export interface DiscordVoiceState {
  configured: boolean;
  connected: boolean;
  mode: VoiceSessionMode;
  transcribing: boolean;
  bufferedSegments: number;
  error: string | null;
}

interface VoiceAssistantConfiguration {
  guildId?: string;
  voiceChannelId?: string;
  textChannelId?: string;
  allowedUserId?: string;
  pythonPath: string;
  transcriberScript: string;
  whisperModel: string;
}

interface VoiceCommand {
  command: string;
  stage: VoiceCommandStage;
  channelId: string;
  userId: string;
}

interface PendingTranscription {
  resolve: (value: { text: string; elapsedMs: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function wavFromPcm(pcm: Buffer) {
  const header = Buffer.alloc(44);
  const channels = 2;
  const sampleRate = 48_000;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class LocalWhisperTranscriber {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingTranscription>();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastError = "";

  constructor(private readonly configuration: VoiceAssistantConfiguration) {}

  private ensureStarted() {
    if (this.child && !this.child.killed) return;
    this.lastError = "";
    const child = spawn(
      this.configuration.pythonPath,
      [this.configuration.transcriberScript],
      {
        env: {
          ...process.env,
          VOICE_WHISPER_MODEL: this.configuration.whisperModel,
          VOICE_WHISPER_LANGUAGE: "ko",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: { id?: string; text?: string; elapsedMs?: number; error?: string };
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve({
          text: response.text?.trim() ?? "",
          elapsedMs: response.elapsedMs ?? 0,
        });
      }
      this.scheduleIdleStop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.lastError = chunk.toString("utf8").trim().slice(-500);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => {
      this.child = null;
      if (this.pending.size) {
        this.failAll(
          new Error(
            this.lastError || `로컬 음성 인식기가 종료됐어요 (${code ?? "unknown"})`,
          ),
        );
      }
    });
  }

  private failAll(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private scheduleIdleStop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), 10 * 60_000);
  }

  async transcribe(pcm: Buffer) {
    this.ensureStarted();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const requestId = randomUUID();
    const audioPath = path.join(os.tmpdir(), `agent-office-voice-${requestId}.wav`);
    await fs.writeFile(audioPath, wavFromPcm(pcm));
    try {
      const result = await new Promise<{ text: string; elapsedMs: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error("음성 인식이 2분 안에 끝나지 않았어요"));
          }, 120_000);
          this.pending.set(requestId, { resolve, reject, timer });
          this.child!.stdin.write(
            `${JSON.stringify({ id: requestId, path: audioPath })}\n`,
          );
        },
      );
      return result;
    } finally {
      await fs.rm(audioPath, { force: true }).catch(() => undefined);
    }
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify({ action: "quit" })}\n`);
    setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
    }, 1_000).unref();
  }
}

export class DiscordVoiceAssistant {
  private connection: VoiceConnection | null = null;
  private state: DiscordVoiceState;
  private readonly transcriber: LocalWhisperTranscriber;
  private readonly recordingUsers = new Set<string>();
  private transcriptQueue: Promise<void> = Promise.resolve();
  private buffer: string[] = [];
  private voiceStateListenerAttached = false;

  constructor(
    private readonly client: Client,
    private readonly configuration: VoiceAssistantConfiguration,
    private readonly onCommand: (command: VoiceCommand) => Promise<{
      acknowledgement?: string;
    }>,
    private readonly onStateChange: (state: DiscordVoiceState) => void,
  ) {
    this.state = {
      configured: Boolean(
        configuration.guildId &&
          configuration.voiceChannelId &&
          configuration.textChannelId &&
          configuration.allowedUserId,
      ),
      connected: false,
      mode: "idle",
      transcribing: false,
      bufferedSegments: 0,
      error: null,
    };
    this.transcriber = new LocalWhisperTranscriber(configuration);
  }

  getState() {
    return { ...this.state };
  }

  private updateState(patch: Partial<DiscordVoiceState>) {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.getState());
  }

  private readonly handleVoiceStateUpdate = (
    previous: VoiceState,
    current: VoiceState,
  ) => {
    if (current.id !== this.configuration.allowedUserId) return;
    const targetChannelId = this.configuration.voiceChannelId;
    const joined =
      previous.channelId !== targetChannelId &&
      current.channelId === targetChannelId;
    const left =
      previous.channelId === targetChannelId &&
      current.channelId !== targetChannelId;
    if (joined && this.state.mode === "idle") {
      void this.beginDump().catch((error) => {
        this.updateState({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (left && this.state.mode === "dump") {
      if (this.buffer.length) {
        void this.sendText(
          "🎙️ 말씀하신 내용은 그대로 모아뒀어요. `질문 시작`, `정리만`, `실행`, `취소` 중 하나를 눌러주세요.",
        ).catch((error) => {
          this.updateState({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        this.updateState({ mode: "idle", bufferedSegments: 0 });
      }
    }
  };

  async start() {
    if (!this.state.configured || this.connection) return;
    try {
      await this.textChannel();
      const channel = await this.client.channels.fetch(
        this.configuration.voiceChannelId!,
      );
      if (!channel?.isVoiceBased() || !("guild" in channel)) {
        throw new Error("DISCORD_VOICE_CHANNEL_ID가 일반 음성 채널이 아닙니다");
      }
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      this.connection = connection;
      connection.on("error", (error) => {
        this.updateState({ error: error.message.slice(0, 300) });
      });
      connection.on(VoiceConnectionStatus.Ready, () => {
        this.updateState({ connected: true, error: null });
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        this.updateState({ connected: false });
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      if (!this.voiceStateListenerAttached) {
        this.client.on(Events.VoiceStateUpdate, this.handleVoiceStateUpdate);
        this.voiceStateListenerAttached = true;
      }
      connection.receiver.speaking.on("start", (userId) => {
        if (userId !== this.configuration.allowedUserId) return;
        this.captureUtterance(userId);
      });
      this.updateState({ connected: true, error: null });
      if (
        channel.members.has(this.configuration.allowedUserId!) &&
        this.state.mode === "idle"
      ) {
        await this.beginDump();
      }
    } catch (error) {
      this.connection?.destroy();
      this.connection = null;
      this.updateState({
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private captureUtterance(userId: string) {
    if (!this.connection || this.recordingUsers.has(userId)) return;
    this.recordingUsers.add(userId);
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1_200 },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const chunks: Buffer[] = [];
    let finished = false;
    const maxTimer = setTimeout(() => opusStream.destroy(), 90_000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(maxTimer);
      this.recordingUsers.delete(userId);
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 48_000 * 2 * 2 * 0.35) return;
      this.transcriptQueue = this.transcriptQueue
        .then(() => this.transcribeAndRoute(pcm))
        .catch(() => undefined);
    };
    decoder.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    decoder.once("end", finish);
    decoder.once("close", finish);
    decoder.once("error", (error) => {
      this.updateState({ error: `오디오 해독 실패: ${error.message}` });
      finish();
    });
    opusStream.once("error", (error) => {
      this.updateState({ error: `음성 수신 실패: ${error.message}` });
      decoder.end();
    });
    opusStream.once("close", () => decoder.end());
    opusStream.pipe(decoder);
  }

  private async transcribeAndRoute(pcm: Buffer) {
    this.updateState({ transcribing: true, error: null });
    try {
      const result = await this.transcriber.transcribe(pcm);
      if (result.text) await this.routeTranscript(result.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState({ error: message });
      await this.sendText(`⚠️ 음성을 알아듣지 못했어요. ${message}`);
    } finally {
      this.updateState({ transcribing: false });
    }
  }

  private compact(text: string) {
    return text.toLocaleLowerCase().replace(/[\s,.!?~·:;"'“”‘’]/g, "");
  }

  private async routeTranscript(text: string) {
    const compact = this.compact(text);
    const startDump =
      compact.includes("치프듣기시작") ||
      compact.includes("치프생각덤프시작") ||
      compact.includes("생각덤프시작");
    const cancel =
      compact.includes("기록하지마") ||
      compact === "취소" ||
      compact.includes("덤프취소");
    const execute =
      compact === "실행해" ||
      compact.includes("이제실행") ||
      compact.includes("업무시작해");
    const summary =
      compact.includes("정리만해") || compact.includes("정리해줘");
    const interview =
      compact.includes("질문해줘") ||
      compact.includes("인터뷰시작") ||
      compact.includes("여기까지");

    if (startDump) {
      await this.beginDump();
      return;
    }
    if (cancel) {
      await this.cancelSession();
      return;
    }
    if (execute && this.state.mode !== "idle") {
      await this.submit("execute");
      return;
    }
    if (this.state.mode === "dump") {
      if (summary) {
        await this.submit("summary");
      } else if (interview) {
        await this.submit("interview");
      } else {
        this.buffer.push(text.trim());
        this.updateState({ bufferedSegments: this.buffer.length });
      }
      return;
    }
    if (this.state.mode === "interview") {
      this.buffer.push(text.trim());
      this.updateState({ bufferedSegments: this.buffer.length });
      await this.dispatch(
        "interview",
        `[음성 인터뷰 답변]\n대표님의 답변: ${text.trim()}\n\n지금까지의 생각 덤프와 답변을 기억해서, 아직 중요한 정보가 부족하면 가장 중요한 질문 딱 하나만 짧게 하세요. 충분하면 목표·제약·완료 기준만 간단히 정리하고 대표님이 \"실행해\"라고 말할 때까지 기다리세요.`,
      );
      return;
    }

    const direct = text.replace(/^\s*(치프|chief)\s*[,.:~-]?\s*/i, "").trim();
    if (direct !== text.trim() && direct) {
      await this.dispatch("direct", direct);
      return;
    }
    await this.beginDump();
    this.buffer.push(text.trim());
    this.updateState({ bufferedSegments: this.buffer.length });
  }

  private async beginDump() {
    this.buffer = [];
    this.updateState({ mode: "dump", bufferedSegments: 0, error: null });
    await this.sendControlPanel();
  }

  private async cancelSession() {
    this.buffer = [];
    this.updateState({ mode: "idle", bufferedSegments: 0 });
    await this.sendText("🗑️ 이번 음성 메모는 지웠어요. 원본 음성도 저장하지 않았습니다.");
  }

  private async submit(kind: "interview" | "summary" | "execute") {
    if (!this.buffer.length) {
      await this.sendText("아직 모아둔 내용이 없어요. 편하게 더 말씀해주세요.");
      return;
    }
    const transcript = this.buffer.join("\n").slice(0, 60_000);
    if (kind === "execute") {
      this.updateState({ mode: "idle", bufferedSegments: 0 });
      this.buffer = [];
      await this.dispatch(
        "execute",
        `[음성 사용자 실행 승인]\n대표님이 음성으로 충분히 설명하고 실행을 승인했습니다.\n\n전체 맥락:\n${transcript}\n\n이제 실제 업무를 시작하세요. 필요한 역할이 있으면 한 번에 한 명에게만 전달하고, 사용자에게는 완료한 내용과 꼭 필요한 결과만 짧게 보고하세요.`,
      );
      return;
    }
    this.updateState({ mode: "interview" });
    await this.dispatch(
      "interview",
      kind === "summary"
        ? `[음성 생각 덤프 정리]\n${transcript}\n\n아직 실행하지 마세요. 목표·제약·완료 기준·빠진 결정만 짧게 정리하고, 대표님이 \"실행해\"라고 말할 때까지 기다리세요.`
        : `[음성 생각 덤프 / 인터뷰 시작]\n${transcript}\n\n아직 실행하지 마세요. 대표님의 의도를 더 정확히 맞추기 위해 가장 중요한 질문 딱 하나만 짧고 자연스럽게 하세요. 답을 받기 전에는 다음 질문으로 넘어가지 마세요.`,
    );
  }

  private async dispatch(stage: VoiceCommandStage, command: string) {
    const result = await this.onCommand({
      command,
      stage,
      channelId: this.configuration.textChannelId!,
      userId: this.configuration.allowedUserId!,
    });
    if (result.acknowledgement) await this.sendText(result.acknowledgement);
  }

  private async textChannel() {
    const channel = await this.client.channels.fetch(
      this.configuration.textChannelId!,
    );
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error("음성 결과를 보낼 디스코드 채널을 찾지 못했어요");
    }
    return channel;
  }

  private async sendText(content: string) {
    const channel = await this.textChannel();
    await channel.send({ content, allowedMentions: { parse: [] } });
  }

  private async sendControlPanel() {
    const channel = await this.textChannel();
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("office:voice:questions")
        .setLabel("질문 시작")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("office:voice:summary")
        .setLabel("정리만")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("office:voice:execute")
        .setLabel("실행")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("office:voice:cancel")
        .setLabel("취소")
        .setStyle(ButtonStyle.Danger),
    );
    await channel.send({
      content:
        "🎙️ **CHIEF가 자동으로 듣기 시작했어요.** 편하게 길게 말씀하세요. 끝나면 “여기까지, 질문해줘”라고 하거나 아래 버튼을 누르면 됩니다.",
      components: [controls],
      allowedMentions: { parse: [] },
    });
  }

  async handleControl(action: "questions" | "summary" | "execute" | "cancel") {
    if (action === "cancel") {
      await this.cancelSession();
      return "이번 음성 메모를 취소했어요.";
    }
    if (this.state.mode === "idle") {
      return "진행 중인 음성 메모가 없어요. 먼저 “치프, 듣기 시작”이라고 말해주세요.";
    }
    await this.submit(
      action === "questions"
        ? "interview"
        : action === "summary"
          ? "summary"
          : "execute",
    );
    return action === "execute"
      ? "CHIEF가 실행을 시작했어요."
      : action === "summary"
        ? "CHIEF가 실행 없이 정리하고 있어요."
        : "CHIEF가 빠진 정보를 하나씩 물어볼게요.";
  }

  stop(notify = true) {
    this.connection?.removeAllListeners();
    this.connection?.receiver.speaking.removeAllListeners();
    this.connection?.destroy();
    this.connection = null;
    if (this.voiceStateListenerAttached) {
      this.client.off(Events.VoiceStateUpdate, this.handleVoiceStateUpdate);
      this.voiceStateListenerAttached = false;
    }
    this.transcriber.stop();
    this.recordingUsers.clear();
    if (notify) {
      this.updateState({ connected: false, transcribing: false });
    } else {
      this.state = { ...this.state, connected: false, transcribing: false };
    }
  }
}
