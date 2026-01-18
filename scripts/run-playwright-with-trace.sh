#!/bin/bash
# Run Playwright MCP server with TRACE RECORDING for debugging
# Runs headless but records detailed trace files
# View traces at: https://trace.playwright.dev

TRACE_DIR="${1:-./playwright-traces}"

echo "Starting Playwright MCP server with trace recording..."
echo "Traces will be saved to: $TRACE_DIR"
echo "View traces at: https://trace.playwright.dev"
echo ""
echo "The server will be available at: http://localhost:3666"
echo "Press Ctrl+C to stop"
echo ""

mkdir -p "$TRACE_DIR"

# Run headless but with trace recording
# --save-trace captures detailed execution traces
# --shared-browser-context keeps auth state between requests
npx @playwright/mcp \
    --port 3666 \
    --browser chromium \
    --headless \
    --shared-browser-context \
    --save-trace \
    --output-dir "$TRACE_DIR"
