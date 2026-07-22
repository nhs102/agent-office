#!/bin/zsh
set -euo pipefail

LABEL="com.local.codex-agent-office"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ -e "$TARGET" ]]; then
  rm "$TARGET"
fi

print "Agent Office 백그라운드 서비스 등록을 해제했습니다."
