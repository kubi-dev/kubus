#!/bin/bash
# Runs at the start of every Claude Code session. Only in cloud sessions
# (Claude app on the phone, claude.ai/code) it installs what build.py needs.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"
if ! command -v ffmpeg >/dev/null; then
  $SUDO apt-get update -qq >/dev/null 2>&1
  $SUDO apt-get install -y -qq ffmpeg >/dev/null 2>&1 || echo "chmura-start: ffmpeg install failed" >&2
fi
python3 -c "import PIL" 2>/dev/null || pip install -q Pillow 2>/dev/null || pip install -q --break-system-packages Pillow 2>/dev/null || echo "chmura-start: Pillow install failed" >&2
exit 0
