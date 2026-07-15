#!/bin/bash
# start.sh — boots an Xvfb virtual display (used only when a claim attempt
# needs the visible-mode fallback), then runs the persistent web server.

DISPLAY_NUM=":99"
Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
sleep 1
export DISPLAY="$DISPLAY_NUM"

exec node /app/server.js
