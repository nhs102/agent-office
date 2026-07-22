import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Agent Office control room", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Agent Office · Local Codex Control<\/title>/i);
  assert.match(html, /AGENT OFFICE/);
  assert.match(html, /LOCAL CODEX CONTROL/);
  assert.match(html, /에이전트 오피스/);
  assert.match(html, /승인 및 질문/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships a localhost-only Codex bridge and real event client", async () => {
  const [client, styles, bridge, discord, agents, packageJson] = await Promise.all([
    readFile(new URL("../app/AgentOffice.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../orchestrator/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../orchestrator/discord.ts", import.meta.url), "utf8"),
    readFile(new URL("../config/agents.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(client, /new EventSource/);
  assert.match(client, /\/api\/dispatch/);
  assert.doesNotMatch(client, /\/api\/agents\/\$\{selected\.id\}\/message/);
  assert.match(client, /\/api\/agents\/\$\{selected\.id\}\/model/);
  assert.match(client, /const speech = agent\.lastMessage\.trim\(\)/);
  assert.match(client, /bubble-close/);
  assert.match(client, /bubble-copy/);
  assert.match(client, /pixel-animal/);
  assert.match(client, /animal-\$\{agent\.id\}/);
  assert.match(client, /dismissedBubbles/);
  assert.match(client, /\[recipient\.id\]: recipient\.lastMessage/);
  assert.match(client, /const speaking = !movement && spokeRecently/);
  assert.match(client, /selectedReportDetail/);
  assert.match(client, /작업 상세 보기/);
  assert.match(client, /function submitOnEnter/);
  assert.match(client, /getDayPeriod\(now\)/);
  assert.match(client, /createRandomLeisureActivities/);
  assert.match(client, /crypto\.getRandomValues/);
  assert.match(client, /randomBetween\(90_000, 300_000\)/);
  assert.match(client, /커피 타는 중/);
  assert.match(client, /수다 중/);
  assert.match(client, /낮잠 중/);
  assert.match(client, /Shift\+Enter 줄바꿈/);
  assert.match(client, /화이트보드에 업무 붙이기/);
  assert.match(client, /COMMAND BOARD/);
  assert.match(client, /API 환산 비용/);
  assert.match(client, /estimateStandardApiCost/);
  assert.match(client, /cachedInput \* price\.cachedInput/);
  assert.match(client, /"gpt-5\.5": \{ input: 5, cachedInput: 0\.5, output: 30 \}/);
  assert.match(client, /NOTION SYNC/);
  assert.match(client, /useSyncExternalStore/);
  assert.match(client, /agent-office-locale/);
  assert.match(client, /Display language/);
  assert.match(client, /englishAgentCopy/);
  assert.match(client, /translateActivity/);
  assert.match(client, /state\.notion\.databaseUrl/);
  assert.match(client, /DISCORD LIVE/);
  assert.match(client, /state\.discord\.connected/);
  assert.match(client, /office-marquee/);
  assert.doesNotMatch(client, /function agentPosition/);
  assert.match(styles, /\.pixel-agent\s*\{[\s\S]*?z-index:\s*20/);
  assert.match(styles, /data-period="day"/);
  assert.match(styles, /data-period="evening"/);
  assert.match(styles, /\.coffee-zone::after/);
  assert.match(styles, /\.desk::after/);
  assert.match(styles, /\.animal-chief/);
  assert.match(styles, /\.animal-pm/);
  assert.match(styles, /\.animal-engineer/);
  assert.match(styles, /\.animal-finance/);
  assert.match(styles, /\.animal-dispatch/);
  assert.match(styles, /\.animal-research/);
  assert.match(styles, /\.animal-design/);
  assert.match(styles, /\.animal-qa/);
  assert.match(styles, /cloud-drift/);
  assert.match(styles, /leisure-coffee/);
  assert.match(styles, /\.whiteboard-note/);
  assert.match(styles, /\.model-setting/);
  assert.match(styles, /\.language-toggle/);
  assert.match(styles, /\.agent-bubble\s*\{[\s\S]*?z-index:\s*40/);
  assert.match(styles, /\.command-whiteboard\s*\{[\s\S]*?z-index:\s*3/);
  assert.match(bridge, /codex\.request\("turn\/start"/);
  assert.match(bridge, /codex\.request\("turn\/steer"/);
  assert.match(bridge, /agent_office/);
  assert.match(bridge, /send_agent_message/);
  assert.match(bridge, /command_center\.called/);
  assert.match(bridge, /inFlightHandoffs/);
  assert.match(bridge, /pendingUpstreamRoutes/);
  assert.match(bridge, /한 번에 한 명만 호출할 수 있습니다/);
  assert.match(bridge, /office_summary/);
  assert.match(bridge, /agent\.report_detail/);
  assert.match(bridge, /function visitWhiteboard/);
  assert.match(bridge, /createNotionTask/);
  assert.match(bridge, /finishNotionTasks/);
  assert.match(bridge, /NOTION_API_KEY/);
  assert.match(bridge, /DISCORD_BOT_TOKEN/);
  assert.match(bridge, /DISCORD_ALLOWED_USER_ID/);
  assert.match(bridge, /DISCORD_REPORT_FORUM_ID/);
  assert.match(bridge, /DISCORD_MESSAGE_CONTENT_ENABLED/);
  assert.match(bridge, /DISCORD_VOICE_CHANNEL_ID/);
  assert.match(bridge, /DISCORD_VOICE_TEXT_CHANNEL_ID/);
  assert.match(bridge, /VOICE_WHISPER_MODEL/);
  assert.match(bridge, /DISCORD_\$\{agent\.shortRole\}_BOT_TOKEN/);
  assert.match(bridge, /handleDiscordCommand/);
  assert.match(bridge, /finishDiscordTasks/);
  assert.match(bridge, /shouldReportDiscordWork/);
  assert.match(bridge, /reportToForum/);
  assert.match(bridge, /report_to_forum/);
  assert.match(bridge, /sourceMessageId/);
  assert.match(bridge, /discord\.dm_received/);
  assert.match(bridge, /discord\.mention_received/);
  assert.match(bridge, /discord\.discussion_started/);
  assert.match(bridge, /discord\.discussion_turn_completed/);
  assert.match(bridge, /discord\.discussion_completed/);
  assert.match(bridge, /startDiscordDiscussion/);
  assert.match(bridge, /startNextDiscordDiscussionTurn/);
  assert.match(bridge, /participantIds = configuration\.agents/);
  assert.match(bridge, /AGENT OFFICE @everyone 동일 질문/);
  assert.match(bridge, /"답변"/);
  assert.doesNotMatch(bridge, /2차 상호 피드백/);
  assert.doesNotMatch(bridge, /CHIEF 최종 종합/);
  assert.match(bridge, /discord\.report_posted/);
  assert.match(bridge, /discordProgressRoutesForTurn/);
  assert.match(bridge, /discordProgressRoutes\.set/);
  assert.match(bridge, /\["상태", "status"\]/);
  assert.match(bridge, /\["사용량", "usage"\]/);
  assert.match(bridge, /\["중단", "stop", "cancel"\]/);
  assert.match(bridge, /\["승인", "approve"\]/);
  assert.match(bridge, /\["거절", "decline", "deny"\]/);
  assert.match(bridge, /pendingApprovalForAgent/);
  assert.match(bridge, /isDiscordStatusInquiry/);
  assert.match(bridge, /discord\.progress_sent/);
  assert.match(bridge, /discord\.project_started/);
  assert.match(bridge, /projectThreadId/);
  assert.match(bridge, /officeLanguageInstruction/);
  assert.match(bridge, /responseLanguage/);
  assert.match(bridge, /"STARTED"/);
  assert.match(bridge, /"IMPLEMENTING"/);
  assert.match(bridge, /"VERIFYING"/);
  assert.match(bridge, /item\.phase === "commentary"/);
  assert.match(discord, /GatewayIntentBits\.DirectMessages/);
  assert.match(discord, /GatewayIntentBits\.GuildMessages/);
  assert.match(discord, /Partials\.Channel/);
  assert.match(discord, /handleDirectMessage/);
  assert.match(discord, /handleGuildMention/);
  assert.match(discord, /message\.mentions\.users\.has/);
  assert.match(discord, /message\.mentions\.everyone/);
  assert.match(discord, /audience:\s*everyoneCall \? "everyone" : "single"/);
  assert.match(discord, /firstMentionedClientId/);
  assert.match(discord, /configuration\.messageContentEnabled/);
  assert.match(discord, /GatewayIntentBits\.MessageContent/);
  assert.match(discord, /sendDiscussionUpdate/);
  assert.match(discord, /sendHandoffUpdate/);
  assert.match(discord, /sendProgressUpdate/);
  assert.match(discord, /name: "project"/);
  assert.match(discord, /handleProjectInteraction/);
  assert.match(discord, /createProjectThread/);
  assert.match(discord, /finishProjectThread/);
  assert.match(discord, /PROJECT STARTED/);
  assert.match(discord, /detectOfficeLanguage/);
  assert.match(discord, /IN PROGRESS/);
  assert.match(discord, /keepTyping/);
  assert.match(discord, /stopTyping/);
  assert.match(discord, /sendApprovalNeeded/);
  assert.match(discord, /ActionRowBuilder/);
  assert.match(discord, /ButtonStyle\.Success/);
  assert.match(discord, /ButtonStyle\.Danger/);
  assert.match(discord, /office:approval:\$\{agentId\}:accept/);
  assert.match(discord, /interaction\.isButton\(\)/);
  assert.match(discord, /GatewayIntentBits\.GuildVoiceStates/);
  assert.match(discord, /DiscordVoiceAssistant/);
  assert.match(discord, /office:voice:/);
  assert.match(discord, /8_000/);
  assert.match(discord, /sendReport/);
  assert.match(discord, /reactToMessage/);
  assert.match(discord, /message\.react\("👀"\)/);
  assert.match(discord, /message\.react\("🛠️"\)/);
  assert.match(discord, /channel\.threads\.create/);
  assert.match(discord, /availableTags/);
  assert.doesNotMatch(discord, /확인했어요\. 끝나면 여기로 알려드릴게요/);
  assert.match(discord, /등록된 Agent Office 사용자만/);
  assert.match(bridge, /"seat", null, "자리로 돌아가는 중"/);
  assert.match(bridge, /결론\|요약\|완료/);
  assert.match(bridge, /대표님/);
  assert.match(bridge, /account\/rateLimits\/read/);
  assert.match(bridge, /thread\/settings\/update/);
  assert.match(bridge, /agent\.model_updated/);
  assert.match(bridge, /agent\.model\.\$\{agent\.id\}/);
  assert.match(bridge, /HOST = process\.env\.AGENT_OFFICE_HOST \?\? "127\.0\.0\.1"/);
  assert.match(agents, /"model": "gpt-5\.5"/);
  assert.match(agents, /"shortRole": "RESEARCH"/);
  assert.match(agents, /"shortRole": "DESIGN"/);
  assert.match(agents, /"shortRole": "QA"/);
  assert.match(agents, /자연스러운 존댓말/);
  assert.match(agents, /결과가 끝나기 전에 다른 담당자에게/);
  assert.match(packageJson, /"start:office"/);
  assert.match(packageJson, /"@discordjs\/voice"/);
  assert.match(packageJson, /"prism-media"/);
  const voice = await readFile(
    new URL("../orchestrator/voice.ts", import.meta.url),
    "utf8",
  );
  assert.match(voice, /Events\.VoiceStateUpdate/);
  assert.match(voice, /자동으로 듣기 시작했어요/);
});
