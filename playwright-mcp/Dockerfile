FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install the Playwright MCP server
RUN npm install @playwright/mcp

# Pre-install Chromium to avoid 12s delay on first request
RUN npx playwright install chromium

# Copy init script for geolocation
COPY init-page.ts .

# Default port (Railway will override with PORT env var)
ENV PORT=3666

# Run with HTTP transport, bind to all interfaces, allow internal network connections
# --browser chromium: use Chromium (not Chrome which may not be installed)
# --no-sandbox: required when running as root in Docker
# --isolated: allows multiple browser instances
# --init-page: set geolocation to NYC (Times Square)
# Using shell form so $PORT gets expanded
CMD npx @playwright/mcp --port $PORT --host 0.0.0.0 --allowed-hosts "*" --browser chromium --headless --no-sandbox --isolated --init-page ./init-page.ts
