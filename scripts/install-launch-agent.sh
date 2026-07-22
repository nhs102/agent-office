#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h}
LABEL="com.local.codex-agent-office"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$PROJECT_ROOT/launchd/$LABEL.plist.template"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_ROOT/.agent-office"
escaped_root=${PROJECT_ROOT//\/\\}
escaped_root=${escaped_root//&/\\&}
escaped_root=${escaped_root//|/\\|}
sed "s|__PROJECT_ROOT__|$escaped_root|g" "$TEMPLATE" > "$TARGET"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

print "Agent Office가 로그인 백그라운드 서비스로 등록되었습니다."
print "대시보드: http://127.0.0.1:3000"
