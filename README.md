# Codex Agent Office

Codex Agent Office is a local operations center for managing real Codex threads through the ChatGPT/Codex session already signed in on your Mac. It does not require a separate OpenAI API key.

## What It Connects

- Eight persistent, role-based Codex threads
- Direct `@role` commands from the side panel, task display on the central command board, and sequential handoffs between roles
- Thread creation, resumption, follow-up messages, in-progress adjustments, and interruption
- Live command execution, file changes, tool calls, plans, and response events
- Sub-agent dispatch, task delivery, waiting, and completion status
- Actual token usage per thread, ChatGPT Codex limits, and API-equivalent cost estimates
- The models available to the current authenticated session, with per-agent model selection
- Command and file-change approvals, plus responses to Codex questions
- SQLite event, message, and approval logs
- Automatic Notion task-board creation and synchronization of command-board tasks, status, and results
- Discord slash commands for remote task dispatch from a phone and completion notifications
- Optional automatic startup at macOS login through `launchd`

## Authentication

The local bridge runs `codex app-server` as a background process. The app server reuses the existing ChatGPT sign-in from Codex CLI.

The bridge never reads or copies `~/.codex/auth.json` directly. Treat that file like a password and never commit it to a repository.

```bash
npm run codex:status
```

The system is ready when the command reports `Logged in using ChatGPT`.

## Development

```bash
npm install
npm run dev:all
```

- Dashboard: `http://127.0.0.1:3000`
- Local Codex bridge: `http://127.0.0.1:8788`

To run the frontend and bridge separately, use `npm run dev` and `npm run dev:office`.

## Notion Integration

Store the Notion integration token in `.env.local` at the project root. The file is excluded from Git, and the token is never stored in the browser or SQLite.

```bash
NOTION_API_KEY=ntn_...
```

After the bridge restarts, it creates the `Agent Office 업무` task board. A command-board task is registered as `진행 중` (In Progress), then updated to `완료` (Completed) with a short result when the assigned agent returns its final response. Select `NOTION SYNC` in the dashboard header to open the task board.

## Discord Integration

Add the Discord bot configuration to `.env.local`, and the local bridge will connect through the Discord Gateway. No inbound port or public web address is required.

```bash
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...
DISCORD_CHANNEL_ID=...
DISCORD_REPORT_FORUM_ID=...
DISCORD_ALLOWED_USER_ID=...
DISCORD_MESSAGE_CONTENT_ENABLED=false
DISCORD_VOICE_CHANNEL_ID=...
DISCORD_VOICE_TEXT_CHANNEL_ID=...

# Add only the role-specific DM bots you need
DISCORD_PM_BOT_TOKEN=...
DISCORD_PM_APPLICATION_ID=...
DISCORD_ENGINEER_BOT_TOKEN=...
DISCORD_ENGINEER_APPLICATION_ID=...
```

Restarting the bridge registers the `/office` command in the configured server. Choose an assignee and enter a command in Discord; the matching persistent Codex thread starts the task and returns the final response to the same channel. Commands are accepted only from the configured server and channel.

### Project Workflow

Use `/project` in the command channel to start a project. Enter `title` and `task`, then optionally choose an `owner`; CHIEF is the default. Agent Office immediately creates an `In Progress` post in the Projects forum and returns its link in the original channel.

The forum post receives the complete remote-visible workflow: `STARTED`, `PLAN`, meaningful `UPDATE` messages, role handoffs, `IMPLEMENTING`, `VERIFYING`, approval requests, and the final result. On completion, the post title and tag change to `Completed`; failed or interrupted projects change to `Paused`.

The request language is stored with the project. English requests keep all start messages, handoffs, updates, approvals, and final results in English. Korean requests use the configured friendly Korean tone.

### Role Bots, Mentions, and DMs

When role-specific credentials are configured, the same orchestrator process signs in those bots as well. PM bot DMs go directly to the persistent PM thread, and Engineer bot DMs go to the persistent Engineer thread. Results return to the same DM. Only the account matching `DISCORD_ALLOWED_USER_ID` can issue commands.

The DM commands `상태` (Status), `사용량` (Usage), `중단` (Stop), and `도움말` (Help) are handled immediately without creating a new Codex task.

In a server channel, mention a bot and place the task after it, for example `@Agent Office`, `@Agent Office PM`, or `@Agent Office Engineer`. If a message mentions several bots, only the first mentioned bot receives the command.

When CHIEF hands a project to the next role, such as DESIGN, ENGINEER, or QA, Discord receives a short status line such as `CHIEF → ENGINEER · IN PROGRESS`. Tasks started from Discord continue to publish key progress updates and the final result in the same channel. Internal reasoning and every shell command are intentionally omitted; only information useful for remote supervision is sent.

The original Discord message receives progress reactions:

- `👀` acknowledged
- `🛠️` started
- `✅` completed
- `⚠️` failed

The same behavior works in forum posts when the bot role can view the channel, read message history, and add reactions.

Mentioning `@Agent Office @everyone` sends the same question sequentially to all eight roles, including CHIEF. Each role posts its own answer in the same channel without aggregating or reviewing the other agents' responses. To support a message beginning with only `@everyone`, enable Message Content Intent for the Agent Office bot in the Discord Developer Portal and set `DISCORD_MESSAGE_CONTENT_ENABLED=true`.

When `DISCORD_REPORT_FORUM_ID` is configured, only substantive work—implementation, modification, verification, research, or documentation—creates a result post in the forum. Greetings, introductions, menu suggestions, `@everyone` discussions, and other casual chat remain in the original channel. Prefix an ambiguous task with `[PROJECT]` or `Project:` to force a report, or `[CHAT]` to keep it out of the forum. Project detection also recognizes task verbs such as `Build`, `Implement`, and `Review`. If the forum defines `Completed` and `Failed` tags, Agent Office applies the appropriate tag automatically.

### CHIEF Voice Brain Dump

When `DISCORD_VOICE_CHANNEL_ID` is configured, the primary Agent Office bot joins that standard voice channel. When the authorized user enters, a new brain-dump session begins automatically with no wake phrase. Only audio from `DISCORD_ALLOWED_USER_ID` is received.

Speech is transcribed locally on the Mac with MLX Whisper. No OpenAI API key is used. The original audio exists only as a temporary WAV file, is deleted immediately after transcription, and audio from other users is not subscribed to.

Supported Korean voice controls:

- Join the voice channel — automatically begin a new brain dump
- `치프, 듣기 시작` — clear the current context and begin a new brain dump
- `여기까지, 질문해줘` — have CHIEF ask for missing information one question at a time
- `정리만 해` — summarize the goal, constraints, and completion criteria without executing
- `이제 실행해` — start the actual task with the collected context
- `기록하지 마` — discard the current voice memo

When `DISCORD_VOICE_TEXT_CHANNEL_ID` is configured, brain-dump summaries, interview questions, control buttons, and CHIEF's final response are sent to that dedicated voice-log channel. Without it, Agent Office uses the regular command channel.

The default transcription model is the approximately 500 MB `mlx-community/whisper-small-mlx`. Configure a larger model only when needed:

```bash
VOICE_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo
```

## Production-Style Local Run

```bash
npm run build
npm run start:local
```

## Start Automatically at macOS Login

Confirm the Codex login in the current terminal, then build the project before installing the launch agent:

```bash
npm run codex:status
npm run build
./scripts/install-launch-agent.sh
```

To remove it:

```bash
./scripts/uninstall-launch-agent.sh
```

Logs are written to `.agent-office/`. The installer registers the service in `~/Library/LaunchAgents` only when you explicitly run it.

## Agent Configuration

Edit `config/agents.json` to configure each role:

- Persona and developer instructions
- Working directory
- Model
- Sandbox mode: `read-only`, `workspace-write`, or `danger-full-access`
- Approval policy: `untrusted`, `on-request`, or `never`
- Pixel-character colors and desk position

By default, general agents use `workspace-write + on-request`, while FINANCE uses `read-only + on-request`.

List the models available to the authenticated Codex session:

```bash
curl http://127.0.0.1:8788/api/models
```

Regenerate protocol types after upgrading Codex:

```bash
npm run schema:codex
```

## Architecture

```text
Codex Agent Office UI :3000
          │ HTTP + SSE
          ▼
Local Orchestrator :8788
          │ JSON-RPC over stdio
          ▼
codex app-server
          │
          └── Existing ChatGPT-authenticated session
```

`codex app-server` handles authentication, thread history, approval requests, and real-time events. The local orchestrator converts those events into role-based agent state and stores operational records in SQLite.

## Local API

- `GET /api/health` — authentication and runtime status
- `GET /api/state` — complete dashboard state
- `GET /api/events` — real-time Server-Sent Events
- `GET /api/models` — models available to the current authenticated session
- `POST /api/dispatch` — send a command-board instruction to an `@role` or CHIEF
- `POST /api/agents/:id/message` — start a task or adjust an active task
- `POST /api/agents/:id/model` — change the model used by the agent's next task
- `POST /api/agents/:id/interrupt` — interrupt the active turn
- `POST /api/approvals/:id/respond` — answer an approval request or Codex question

The bridge binds to `127.0.0.1` by default. Do not expose it directly to an external network.

## Dashboard Behavior

Use `@CHIEF`, `@PM`, `@ENGINEER`, `@FINANCE`, `@DISPATCH`, `@RESEARCH`, `@DESIGN`, or `@QA` in the side command panel to address a persistent role directly. The central command board is a display for the latest task and its owner, not an input form.

The command panel accepts one role per request. If the role is omitted, CHIEF receives the request first. When another role is required, only one handoff is made at a time; the next handoff does not begin until the previous agent's result returns. Internal handoff results are routed back to the requesting agent's thread.

Each agent has a separate persona and speaking style. Speech bubbles can be closed and show only a one- or two-sentence summary of what was completed and any essential result. Evidence, execution history, and verification steps remain available under `View task details`. Report-style markers such as `Conclusion:` and `Summary:` and other Markdown formatting are removed from the compact summary.

Press `Enter` to send from the command panel and `Shift+Enter` for a new line. Existing speech bubbles remain hidden while an agent walks to the command board or returns to its desk. A new bubble appears only after the agent reaches its desk and generates a new response.

Idle animal characters occasionally make coffee, chat around the meeting table, nap, or stretch at long randomized intervals. Some idle cycles intentionally do nothing to prevent repetitive animation. These scenes use mock state only and never make Codex requests or consume tokens.

## API-Equivalent Cost

The dashboard's `API-equivalent cost` applies the selected model's standard API rates to recorded regular-input, cached-input, and output tokens. It is not an actual ChatGPT subscription charge; it estimates what the same token usage would cost through the API.

The estimate includes the cached-input discount but excludes separate tool-call charges, Batch, Priority, regional processing rates, and any request-specific long-context surcharges.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
