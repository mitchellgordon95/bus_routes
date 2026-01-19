FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install Xvfb for virtual display (headed mode without real display)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Install the Playwright MCP server
RUN npm install @playwright/mcp

# Pre-install Chromium to avoid 12s delay on first request
RUN npx playwright install chromium

# Default port (Railway will override with PORT env var)
ENV PORT=3666

# Virtual display for Xvfb
ENV DISPLAY=:99

# Start Xvfb, then run Playwright MCP in headed mode with persistent user data
# --browser chromium: use Chromium (not Chrome which may not be installed)
# --no-sandbox: required when running as root in Docker
# --shared-browser-context: all requests share same browser context (enables auth persistence)
# --user-data-dir: persist cookies/session across container restarts (requires Railway volume)
# Using shell form so $PORT gets expanded
CMD Xvfb :99 -screen 0 1920x1080x24 & \
    sleep 1 && \
    npx @playwright/mcp --port $PORT --host 0.0.0.0 --allowed-hosts "*" \
        --browser chromium --no-sandbox --shared-browser-context \
        --user-data-dir /data/browser-profile
