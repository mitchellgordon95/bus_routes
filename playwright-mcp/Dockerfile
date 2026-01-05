FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install the Playwright MCP server
RUN npm install @playwright/mcp

# Default port (Railway will override with PORT env var)
ENV PORT=3666

# Run with SSE transport, bind to all interfaces, headless mode
# Using shell form so $PORT gets expanded
CMD npx @playwright/mcp --port $PORT --host 0.0.0.0 --headless
