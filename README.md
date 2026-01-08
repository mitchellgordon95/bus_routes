# TextPal

An SMS-based personal assistant that handles everyday tasks through AI agents and API integrations. Text it to check bus times, track calories, or get Uber quotes.

## Features

### Bus Arrival Times
Real-time NYC MTA bus arrivals via the BusTime API.
```
308209        → All buses at stop 308209
308209 B63    → Only B63 buses at that stop
R             → Refresh last query
```

### Calorie Tracking
AI-powered food logging using Google Gemini for natural language and image understanding.
```
2 eggs and toast     → Logs ~250 cal
[send photo]         → Estimates calories from image
total                → Today's total vs target
sub 50               → Subtract 50 calories
target 2000          → Set daily goal
suggest 300 sweet    → Get food ideas for 300 cal
reset calories       → Start fresh
```

### Uber Quotes
Get ride estimates using Claude as a browser automation agent.
```
uber times square to jfk    → Get price quote and ride options
uber confirm                → Book the ride (coming soon)
uber status                 → Check ride status
uber cancel                 → Cancel ride
```

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│     Twilio      │     │              Railway                      │
│  (SMS Gateway)  │────▶│  ┌─────────────────────────────────────┐ │
└─────────────────┘     │  │         Express Server              │ │
                        │  │  • Message routing                  │ │
                        │  │  • MTA API integration              │ │
                        │  │  • Gemini AI (calories)             │ │
                        │  │  • Claude AI (Uber agent)           │ │
                        │  └──────────────┬──────────────────────┘ │
                        │                 │                        │
                        │  ┌──────────────▼──────────────────────┐ │
                        │  │     Playwright MCP Server           │ │
                        │  │  • Headless Chromium                │ │
                        │  │  • Browser automation tools         │ │
                        │  └─────────────────────────────────────┘ │
                        │                                          │
                        │  ┌─────────────────────────────────────┐ │
                        │  │           PostgreSQL                │ │
                        │  │  • Calorie logs                     │ │
                        │  │  • Pending Uber rides               │ │
                        │  └─────────────────────────────────────┘ │
                        └──────────────────────────────────────────┘
```

### How AI Agents Work

**Calorie Tracking**: Uses Google Gemini to parse natural language food descriptions and analyze food photos, returning structured calorie estimates.

**Uber Quotes**: Uses Claude with the Playwright MCP server for browser automation. Claude receives a task ("get Uber quote from A to B") and uses browser tools (`browser_navigate`, `browser_click`, `browser_type`, etc.) to complete it. This approach is resilient to UI changes since Claude interprets the page rather than relying on hardcoded selectors.

## Setup

### Prerequisites
- Node.js 20+
- PostgreSQL database
- API keys: Twilio, MTA BusTime, Google Gemini, Anthropic

### Environment Variables

```bash
cp .env.example .env.local
```

```
# Twilio
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token

# MTA BusTime API
MTA_API_KEY=your_key

# Google Gemini (calorie estimation)
GEMINI_API_KEY=your_key

# Anthropic (Uber agent)
ANTHROPIC_API_KEY=your_key

# PostgreSQL
DATABASE_URL=postgresql://user:pass@host:port/db

# Playwright MCP Server (for Uber)
PLAYWRIGHT_MCP_URL=http://localhost:3666
```

### Local Development

```bash
npm install
npm run dev
```

For Uber functionality, run the Playwright MCP server:
```bash
npx @playwright/mcp --port 3666 --browser chromium --headless --no-sandbox
```

### Deploy to Railway

1. Create a new Railway project
2. Add PostgreSQL service
3. Add Express server from this repo (root directory)
4. Add Playwright MCP service from `playwright-mcp/` subdirectory
5. Configure environment variables
6. Set Twilio webhook to `https://your-app.railway.app/sms`

## Project Structure

```
.
├── server.js              # Express server & request handling
├── message-handler.js     # SMS command parsing & routing
├── mta-api.js             # MTA BusTime API client
├── gemini-api.js          # Google Gemini integration
├── calorie-tracker.js     # Calorie database operations
├── uber-agent.js          # Claude + MCP browser automation
├── uber-pending.js        # Uber ride state management
├── playwright-mcp/        # Playwright MCP Docker service
│   └── Dockerfile
└── Dockerfile             # Main Express server
```

## Cost Estimate

| Service | Cost |
|---------|------|
| Twilio SMS | ~$0.0079/message |
| MTA API | Free |
| Gemini API | Free tier available |
| Anthropic API | ~$0.003/1K input tokens |
| Railway | ~$5/month |

## License

MIT
