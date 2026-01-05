FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install the Playwright MCP server
RUN npm install @playwright/mcp

# Default port (Railway will override with PORT env var)
ENV PORT=3666

# Run with HTTP transport, bind to all interfaces, allow internal network connections
# --isolated: allows multiple browser instances (avoids "browser in use" conflicts)
# Using shell form so $PORT gets expanded
CMD npx @playwright/mcp --port $PORT --host 0.0.0.0 --allowed-hosts "*" --headless --isolated
