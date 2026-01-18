#!/bin/bash
# Run Playwright MCP server in HEADED mode for debugging
# This opens a visible browser window so you can watch the automation

echo "Starting Playwright MCP server in HEADED mode..."
echo "Browser window will be visible for debugging."
echo ""
echo "The server will be available at: http://localhost:3666"
echo "Press Ctrl+C to stop"
echo ""

# Run without --headless flag to show the browser window
# --shared-browser-context keeps auth state between requests
npx @playwright/mcp \
    --port 3666 \
    --browser chromium \
    --shared-browser-context
