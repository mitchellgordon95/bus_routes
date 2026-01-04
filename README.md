# NYC Bus SMS Service

A simple SMS-based service to get real-time NYC MTA bus arrival times, recreating the functionality of the now-defunct 511123 service.

## Features

- Text a bus stop code to get real-time arrival information
- Filter by specific route (e.g., "308209 B63")
- Refresh recent queries with "R"
- Shows stops away and estimated arrival times
- Works with all NYC MTA buses

## Quick Start

### 🚀 Deploy to Vercel (Recommended - 5 minutes)

The easiest way to get started! See **[VERCEL_DEPLOY.md](VERCEL_DEPLOY.md)** for complete instructions.

**TL;DR:**
1. Get your MTA API key and Twilio credentials
2. Push this repo to GitHub
3. Import to Vercel and add environment variables
4. Configure Twilio webhook with your Vercel URL
5. Done!

### 🛠 Local Development

#### 1. Get API Keys

**MTA Bus Time API Key (Free)**
- Go to https://register.developer.obanyc.com/
- Fill out the registration form
- You'll receive an API key via email within 30 minutes

**Twilio Account (Free tier available)**
- Sign up at https://www.twilio.com/try-twilio
- Get a phone number (free trial includes one)
- Note your Account SID and Auth Token from the console

#### 2. Install Dependencies

```bash
npm install
```

#### 3. Configure Environment Variables

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your keys:
```
MTA_API_KEY=your_actual_mta_api_key
TWILIO_ACCOUNT_SID=your_actual_account_sid
TWILIO_AUTH_TOKEN=your_actual_auth_token
DATABASE_URL=postgresql://user:password@host:port/database
```

#### 4. Test Locally

Run the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### 5. Test the MTA API

You can test the MTA API connection:
```bash
node test-mta.js
```

### 6. Expose Local Server (for testing)

Use ngrok to expose your local server to receive Twilio webhooks:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### 7. Configure Twilio Webhook

1. Go to https://console.twilio.com/
2. Navigate to Phone Numbers → Manage → Active numbers
3. Click your phone number
4. Under "Messaging Configuration"
5. Set "A MESSAGE COMES IN" webhook to: `https://your-ngrok-url.ngrok.io/sms`
6. Set HTTP method to `POST`
7. Save

## Usage

Once deployed, text your Twilio number:

### Basic Query
```
308209
```
Returns all buses arriving at stop 308209

### Filtered by Route
```
308209 B63
```
Returns only B63 buses at stop 308209

### Refresh
```
R
```
Refreshes your last query (within 20 minutes)

## Finding Bus Stop Codes

1. Visit https://bustime.mta.info/
2. Search for your stop or route
3. The 6-digit code is displayed at each stop
4. Or look for the code printed on the physical bus stop sign

## Deployment Options

### ⭐ Vercel (Recommended)
**Best for:** Serverless, zero config, free tier
**Guide:** See [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md)

- Push to GitHub → Import to Vercel → Done
- Automatic HTTPS and global CDN
- Free tier handles millions of requests/month

### Railway.app
**Best for:** Traditional server deployment

1. Push code to GitHub
2. Connect Railway to your repo
3. Add environment variables in Railway dashboard
4. Railway provides a public URL automatically

### Heroku
**Best for:** Familiar platform

```bash
heroku create your-app-name
heroku config:set MTA_API_KEY=your_key
heroku config:set TWILIO_ACCOUNT_SID=your_sid
heroku config:set TWILIO_AUTH_TOKEN=your_token
git push heroku main
```

### Other Options
DigitalOcean, AWS, Google Cloud, etc. - Deploy as a standard Node.js app.

## Project Structure

```
.
├── api/
│   └── sms.js              # Vercel serverless function (webhook)
├── public/
│   └── index.html          # Landing page
├── server.js               # Express server (for local dev)
├── mta-api.js             # MTA Bus Time API client
├── message-handler.js     # SMS message parser & session manager
├── test-mta.js            # Test script for MTA API
├── vercel.json            # Vercel configuration
├── package.json           # Dependencies
├── .env.example           # Environment variables template
├── README.md              # This file
├── VERCEL_DEPLOY.md       # Vercel deployment guide
└── QUICKSTART.md          # Quick setup guide
```

## Cost Estimate

- **MTA API**: Free
- **Twilio SMS**: ~$0.0079 per message (sent + received)
  - 100 messages = ~$0.79
  - 1000 messages = ~$7.90
- **Hosting**:
  - **Vercel**: Free tier (up to 100GB bandwidth & millions of requests/month)
  - Railway/Heroku free tier: $0
  - Or as low as $5/month for paid hosting

**Total cost for personal use: ~$1-5/month** (just Twilio SMS fees)

## Limitations

- Requires valid 6-digit MTA stop codes
- Intersection search not yet implemented
- Service changes ("C" command) not yet implemented
- Session data stored in memory (resets on server restart)

## Future Enhancements

- [ ] Add intersection-based search
- [ ] Implement service alerts/changes
- [ ] Persistent session storage (Redis)
- [ ] Support for subway arrivals
- [ ] Rate limiting per phone number

## Troubleshooting

**"No buses found"**: Verify the stop code at https://bustime.mta.info/

**No SMS received**: Check Twilio webhook configuration and server logs

**API errors**: Verify your MTA API key is valid

## License

MIT
