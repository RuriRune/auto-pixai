#!/bin/bash
# start.sh — boots Xvfb virtual display then runs the claimer

DISPLAY_NUM=":99"
SCREEN="0"
RESOLUTION="1280x1024x24"

# Kill any stale Xvfb from a previous run
pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true
sleep 0.5

# Start virtual display
Xvfb "$DISPLAY_NUM" -screen "$SCREEN" "$RESOLUTION" -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Give it a moment to initialise
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[START] Xvfb failed to start — aborting"
    exit 1
fi

echo "[START] Xvfb running on display $DISPLAY_NUM (PID $XVFB_PID)"

export DISPLAY="$DISPLAY_NUM"

# Run the claimer
node /app/app.js
EXIT_CODE=$?

# Clean up
kill "$XVFB_PID" 2>/dev/null || true

exit $EXIT_CODE