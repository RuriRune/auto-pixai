#!/bin/bash
# start.sh — boots an Xvfb virtual display (used only if the headless attempt
# needs to fall back to a visible browser), then runs the claimer.

DISPLAY_NUM=":99"
SCREEN="0"
RESOLUTION="1280x900x24"

pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true
sleep 0.5

Xvfb "$DISPLAY_NUM" -screen "$SCREEN" "$RESOLUTION" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[START] Xvfb failed to start — visible-mode fallback will not work, continuing headless-only"
else
    echo "[START] Xvfb running on display $DISPLAY_NUM (PID $XVFB_PID)"
fi

export DISPLAY="$DISPLAY_NUM"

node /app/app.js
EXIT_CODE=$?

kill "$XVFB_PID" 2>/dev/null || true

exit $EXIT_CODE
