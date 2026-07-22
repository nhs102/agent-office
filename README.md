# Codex Agent Office

맥에 로그인된 ChatGPT/Codex 세션으로 실제 Codex 스레드를 운영하는 로컬 관제실입니다. OpenAI API 키를 별도로 넣지 않습니다.

## 현재 연결되는 기능

- 8개 역할별 상주 Codex 스레드
- 우측 명령창의 `@역할` 단일 호출, 중앙 화이트보드 업무 표시, 역할 간 순차 메시지 전달
- 스레드 시작, 재개, 메시지 전달, 진행 중 메시지 조정, 작업 중단
- 명령 실행, 파일 변경, 도구 호출, 계획, 응답 이벤트 실시간 표시
- 서브에이전트 소환·업무 전달·대기·종료 표시
- 스레드별 실제 토큰 사용량, ChatGPT Codex 한도, 표준 API 단가 환산액 표시
- 현재 로그인 세션의 실제 모델 목록과 에이전트별 모델 변경
- 명령 및 파일 변경 승인, Codex 질문 응답
- SQLite 이벤트·메시지·승인 로그
- 노션 업무 보드 자동 생성 및 화이트보드 업무 상태·결과 동기화
- Discord 슬래시 명령으로 휴대폰에서 업무 전달 및 완료 알림 수신
- macOS 로그인 시 자동 실행하는 `launchd` 설정

## 인증 방식

로컬 브리지는 `codex app-server`를 백그라운드 프로세스로 실행합니다. 이 프로세스가 기존 Codex CLI의 ChatGPT 로그인을 그대로 재사용합니다.

브리지는 `~/.codex/auth.json`을 직접 읽거나 복사하지 않습니다. 인증 파일은 비밀번호처럼 취급해야 하며 저장소에 넣으면 안 됩니다.

```bash
npm run codex:status
```

출력이 `Logged in using ChatGPT`이면 준비된 상태입니다.

## 개발 실행

```bash
npm install
npm run dev:all
```

- 대시보드: `http://127.0.0.1:3000`
- 로컬 Codex 브리지: `http://127.0.0.1:8788`

프론트엔드와 브리지를 따로 실행하려면 `npm run dev`와 `npm run dev:office`를 각각 사용합니다.

## 노션 연결

프로젝트 루트의 `.env.local`에 노션 통합 토큰을 저장합니다. 이 파일은 Git에서
제외되며 토큰은 브라우저나 SQLite에 저장하지 않습니다.

```bash
NOTION_API_KEY=ntn_...
```

브리지를 다시 시작하면 `Agent Office 업무` 보드가 만들어집니다. 중앙
화이트보드 명령은 `진행 중`으로 등록되고, 담당 에이전트의 최종 답이 오면
`완료`와 짧은 결과가 자동으로 기록됩니다. 상단의 `NOTION SYNC`를 누르면
업무 보드를 바로 열 수 있습니다.

## Discord 연결

`.env.local`에 Discord 봇 설정을 저장하면 로컬 브리지가 Gateway로 접속합니다.
외부 포트를 열거나 공개 웹 주소를 만들 필요는 없습니다.

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

# 역할별 DM 봇은 필요한 역할만 추가
DISCORD_PM_BOT_TOKEN=...
DISCORD_PM_APPLICATION_ID=...
DISCORD_ENGINEER_BOT_TOKEN=...
DISCORD_ENGINEER_APPLICATION_ID=...
```

브리지를 다시 시작하면 지정한 서버에 `/office` 명령이 등록됩니다. 디스코드에서
`담당`과 `명령`을 선택하면 해당 상주 Codex 스레드가 작업을 시작하고, 최종 답변은
같은 채널로 돌아옵니다. 명령은 설정된 서버와 채널에서만 받습니다.

새 프로젝트는 명령 채널에서 `/project`를 사용합니다. `title`, `task`를 입력하고
필요하면 `owner`를 고릅니다. 기본 담당자는 CHIEF입니다. 실행 즉시 Projects 포럼에
`In Progress` 글이 만들어지고, 원래 채널에는 포럼 링크가 표시됩니다. 이후
`STARTED`, `PLAN`, 중간 `UPDATE`, 역할 전달, `IMPLEMENTING`, `VERIFYING`, 승인
요청과 최종 결과가 모두 해당 포럼 글 안에 쌓입니다. 완료 시 `Completed`, 실패나
중단 시 `Paused` 태그와 글 제목이 자동으로 바뀝니다.

프로젝트 요청의 언어도 함께 저장됩니다. 영어로 요청하면 포럼 시작 안내부터 역할
전달, 중간 진행 보고, 승인 요청과 최종 결과까지 영어로 유지하고, 한국어 요청은
기존의 친근한 한국어 말투를 사용합니다.

역할별 토큰이 있으면 같은 오케스트레이터 프로세스가 해당 봇에도 로그인합니다.
PM 봇 DM은 PM 상주 스레드로, 엔지니어 봇 DM은 엔지니어 상주 스레드로 바로
전달되며 완료 결과도 같은 DM으로 돌아옵니다. `DISCORD_ALLOWED_USER_ID`와 일치하는
본인 계정만 명령할 수 있습니다. DM에서 `상태`, `사용량`, `중단`, `도움말`은
Codex 작업을 새로 만들지 않고 즉시 처리됩니다.

서버 채팅에서는 `@Agent Office`, `@Agent Office PM`,
`@Agent Office Engineer`처럼 봇을 직접 멘션하고 뒤에 업무를 적으면 해당 봇의
상주 에이전트가 처리합니다. 여러 봇을 한 메시지에 멘션하면 가장 먼저 적은 봇만
명령을 받습니다.

CHIEF가 프로젝트 업무를 DESIGN, ENGINEER, QA처럼 다음 담당자에게 넘길 때는
같은 Discord 채널에 `CHIEF → ENGINEER · IN PROGRESS` 형식의 짧은 진행 표시를
남깁니다. Discord에서 시작한 업무는 같은 채널에 `STARTED`, `PLAN`,
`IMPLEMENTING`, `VERIFYING`, 에이전트의 실제 중간 `UPDATE`, 승인 요청과 최종
결과까지 이어서 보여줍니다. 내부 추론이나 모든 셸 명령은 보내지 않아 원격
관제에 필요한 주요 진행 상황만 남깁니다.

멘션이나 DM으로 받은 원본 메시지에는 진행 상태가 반응으로 표시됩니다. `👀`은
확인, `🛠️`는 작업 시작, `✅`는 완료, `⚠️`는 실패입니다. 포럼 게시글에서도
봇 역할에 `채널 보기`, `메시지 기록 보기`, `반응 추가` 권한이 있으면 동일하게
작동합니다.

`@Agent Office @everyone 질문`처럼 호출하면 CHIEF를 포함한 8명 모두에게 같은
질문을 한 번씩 순서대로 보냅니다. 각 역할은 서로의 답을 취합하거나 피드백하지
않고 자기 답만 같은 채널에 남긴 뒤 종료합니다.
`@everyone 안건`만으로 시작하려면 Discord Developer Portal의 Agent Office 봇에서
Message Content Intent를 켜고 `DISCORD_MESSAGE_CONTENT_ENABLED=true`로 바꿉니다.

`DISCORD_REPORT_FORUM_ID`에 포럼 채널 ID를 지정하면 구현, 수정, 점검, 조사,
문서화처럼 실제 결과물이 있는 업무만 담당 역할과 최종 결과를 새 게시글로
남깁니다. 인사, 자기소개, 메뉴 추천, `@everyone` 같은 잡담은 채널에서만 답하고
포럼에는 기록하지 않습니다. 애매한 요청은 `[프로젝트]` 또는 `프로젝트:`를 붙이면
강제로 기록하고, `[잡담]`을 붙이면 기록하지 않습니다. 영어 명령은 `[PROJECT]`,
`Project:` 또는 `Build`, `Implement`, `Review` 같은 업무 표현을 인식합니다. 포럼에
`완료`/`Completed`, `실패`/`Failed` 태그가 있으면 결과 상태에 맞게 자동으로
붙습니다.

### CHIEF 음성 생각 덤프

`DISCORD_VOICE_CHANNEL_ID`가 있으면 메인 `Agent Office` 봇이 해당 일반 음성
채널에 접속합니다. 등록된 사용자가 채널에 들어오면 별도 호출어 없이 자동으로
새 생각 덤프를 시작하고, `DISCORD_ALLOWED_USER_ID`의 음성만 받습니다.
음성은 맥의 MLX Whisper로 로컬 변환하며 OpenAI API 키를 사용하지 않습니다.
원본 음성은 임시 WAV로만 처리한 뒤 즉시 삭제되고, 다른 사용자의 음성은
구독하지 않습니다.

- 음성 채널 입장 — 새 생각 덤프 자동 시작
- `치프, 듣기 시작` — 진행 중인 내용을 비우고 새 생각 덤프 시작
- `여기까지, 질문해줘` — CHIEF가 빠진 정보를 한 번에 하나씩 질문
- `정리만 해` — 실행하지 않고 목표·제약·완료 기준만 정리
- `이제 실행해` — 지금까지의 맥락으로 실제 업무 시작
- `기록하지 마` — 현재 음성 메모 폐기

`DISCORD_VOICE_TEXT_CHANNEL_ID`가 있으면 생각 덤프 요약, 인터뷰 질문,
`질문 시작`, `정리만`, `실행`, `취소` 버튼과 CHIEF의 최종 답변을 모두 해당
음성 기록 채널로 보냅니다. 값이 없을 때만 기존 명령 채널을 사용합니다.
기본 모델은 약 500MB인
`mlx-community/whisper-small-mlx`이며 더 큰 모델을 쓸 때만 다음 값을 추가합니다.

```bash
VOICE_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo
```

## 일반 실행

```bash
npm run build
npm run start:local
```

## 맥 로그인 시 자동 실행

먼저 현재 터미널에서 `npm run codex:status`를 확인하고 빌드를 완료합니다.

```bash
npm run build
./scripts/install-launch-agent.sh
```

해제:

```bash
./scripts/uninstall-launch-agent.sh
```

로그는 `.agent-office/`에 기록됩니다. 이 설치 스크립트는 사용자가 실행할 때만 `~/Library/LaunchAgents`에 서비스를 등록합니다.

## 에이전트 설정

`config/agents.json`에서 다음 값을 역할별로 변경할 수 있습니다.

- 페르소나와 개발자 지침
- 작업 디렉터리
- 모델
- 샌드박스: `read-only`, `workspace-write`, `danger-full-access`
- 승인 정책: `untrusted`, `on-request`, `never`
- 픽셀 캐릭터 색상과 자리

기본값은 일반 에이전트가 `workspace-write + on-request`, 재무 관리자가 `read-only + on-request`입니다.

현재 설치된 Codex가 제공하는 모델은 다음 엔드포인트에서 확인할 수 있습니다.

```bash
curl http://127.0.0.1:8788/api/models
```

Codex 버전을 올린 뒤 프로토콜 타입을 다시 생성하려면 다음을 실행합니다.

```bash
npm run schema:codex
```

## 구조

```text
Codex Agent Office UI :3000
          │ HTTP + SSE
          ▼
Local Orchestrator :8788
          │ JSON-RPC over stdio
          ▼
codex app-server
          │
          └── 기존 ChatGPT 로그인 세션
```

`codex app-server`가 인증, 스레드 이력, 승인 요청, 실시간 이벤트를 담당합니다. 로컬 오케스트레이터는 이를 역할별 에이전트 상태로 변환하고 SQLite에 기록합니다.

## 로컬 API

- `GET /api/health` — 로그인 및 런타임 상태
- `GET /api/state` — 화면 전체 상태
- `GET /api/events` — 실시간 SSE 이벤트
- `GET /api/models` — 현재 로그인 세션에서 사용 가능한 모델
- `POST /api/dispatch` — 화이트보드 지시를 `@역할` 또는 메인 비서에게 전달
- `POST /api/agents/:id/message` — 새 작업 또는 진행 중 작업 조정
- `POST /api/agents/:id/model` — 에이전트의 다음 작업부터 사용할 모델 변경
- `POST /api/agents/:id/interrupt` — 활성 턴 중단
- `POST /api/approvals/:id/respond` — 승인 또는 질문 응답

브리지는 기본적으로 `127.0.0.1`에만 바인딩됩니다. 외부 네트워크에 직접 노출하지 마세요.

오른쪽 명령창에서 `@CHIEF`, `@PM`, `@ENGINEER`, `@FINANCE`, `@DISPATCH`,
`@RESEARCH`, `@DESIGN`, `@QA`를 붙이면 해당 상주 스레드로 직접 전달됩니다.
중앙 화이트보드는 입력 폼이 아니라 최근에 받은 업무와 담당자를 보여줍니다.
명령창은 한 번에 한 역할만
호출할 수 있으며, 역할을 생략하면 메인 비서가 먼저 확인합니다. 다른 역할이
필요할 때도 한 명에게만 내부 전달하고 그 결과가 돌아온 뒤에 다음 한 명을
선택합니다. 내부 전달 결과는 요청한 에이전트 스레드로 다시 돌아옵니다.

각 에이전트는 역할에 맞는 별도 페르소나와 말투를 사용합니다. 말풍선은 닫을 수
있고 기본 보고는 완료한 내용과 핵심 결과만 한두 문장으로 표시합니다. 근거,
수행 내역, 확인 방법은 선택한 에이전트의 `작업 상세 보기`를 열어 따로 확인할 수
있습니다. 요약에서는 `결론:` 같은 보고서 표식과 마크다운을 자동으로 제거합니다.
우측 명령창은 `Enter`로 전송하고 `Shift+Enter`로 줄을 바꿉니다.
화이트보드로 갈 때와 자리로 복귀하는 동안에는 이전 말풍선을 숨기고,
자리에 도착한 뒤 새 응답이 생성되면 그 새 답변만 말풍선으로 나타납니다.

대기 중인 동물 캐릭터는 긴 무작위 간격으로만 커피를 타거나, 회의 테이블에
모여 수다를 떨거나, 낮잠과 기지개 같은 여가 행동을 합니다. 행동이 규칙적으로
이어지지 않도록 일부 무작위 주기는 아무 일 없이 지나갑니다. 이 연출은
목데이터라 Codex 요청이나 토큰을 사용하지 않습니다.

대시보드의 `API 환산 비용`은 각 에이전트에서 기록된 일반 입력, 캐시 입력,
출력 토큰을 현재 선택된 모델의 표준 API 단가로 계산합니다. 실제 ChatGPT 플랜
청구액이 아니라 같은 토큰을 API로 사용했을 때의 비교용 추정치입니다. 캐시
할인은 반영하지만 별도 도구 호출 비용, Batch·Priority·지역 처리 요금, 요청별
장문 컨텍스트 추가요금은 포함하지 않습니다.

## 참고

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
