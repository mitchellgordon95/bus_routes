#!/bin/bash
# Startup script for Playwright MCP with cookie import

# Start Xvfb in background
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Start Playwright MCP server in background
npx @playwright/mcp --port $PORT --host 0.0.0.0 --allowed-hosts "*" \
    --browser chromium --no-sandbox --shared-browser-context \
    --user-data-dir /data/browser-profile &

MCP_PID=$!

# Wait for MCP server to be ready
echo "Waiting for MCP server to start..."
sleep 5

# Import cookies if UBER_COOKIES is set
if [ -n "$UBER_COOKIES" ]; then
    echo "Importing cookies from UBER_COOKIES env var..."
    node /app/import-cookies.js || echo "Cookie import failed (non-fatal)"
fi

# Wait for MCP server process
wait $MCP_PID
