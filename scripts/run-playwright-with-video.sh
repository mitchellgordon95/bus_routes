#!/bin/bash
# Run Playwright MCP server with VIDEO RECORDING for debugging
# Runs headless but records video of all browser activity

VIDEO_DIR="${1:-./playwright-videos}"

echo "Starting Playwright MCP server with video recording..."
echo "Videos will be saved to: $VIDEO_DIR"
echo ""
echo "The server will be available at: http://localhost:3666"
echo "Press Ctrl+C to stop"
echo ""

mkdir -p "$VIDEO_DIR"

# Run headless but with video recording
# --save-video captures browser activity
# --shared-browser-context keeps auth state between requests
npx @playwright/mcp \
    --port 3666 \
    --browser chromium \
    --headless \
    --shared-browser-context \
    --save-video=1280x720 \
    --output-dir "$VIDEO_DIR"
