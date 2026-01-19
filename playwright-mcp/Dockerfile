FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install Xvfb for virtual display (headed mode without real display)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Install the Playwright MCP server and MCP SDK (for cookie import script)
RUN npm install @playwright/mcp @modelcontextprotocol/sdk

# Pre-install Chromium to avoid 12s delay on first request
RUN npx playwright install chromium

# Copy startup scripts
COPY start.sh /app/start.sh
COPY import-cookies.js /app/import-cookies.js
RUN chmod +x /app/start.sh

# Default port (Railway will override with PORT env var)
ENV PORT=3666

# Virtual display for Xvfb
ENV DISPLAY=:99

# Use startup script that handles Xvfb, MCP server, and cookie import
CMD ["/app/start.sh"]
