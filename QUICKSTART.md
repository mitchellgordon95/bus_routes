# Quick Start Guide

Get your NYC Bus SMS service running in 15 minutes!

## Step 1: Get Your MTA API Key (5 minutes)

1. Open https://register.developer.obanyc.com/
2. Fill out the form with:
   - Your email
   - A simple description (e.g., "Personal bus arrival SMS service")
3. Submit the form
4. Check your email - you'll get the API key within 30 minutes (usually instant)

**While waiting, continue to Step 2!**

## Step 2: Set Up Twilio (5 minutes)

### Sign up (Free Trial)
1. Go to https://www.twilio.com/try-twilio
2. Sign up with your email
3. Verify your phone number
4. Skip the "What are you building?" questions (or answer if you want)

### Get a Phone Number
1. In the Twilio Console, go to **Phone Numbers** → **Manage** → **Buy a number**
2. Select your country (United States)
3. Click "Search"
4. Pick any available number
5. Click "Buy"

### Get Your Credentials
1. Go to the Twilio Console home page
2. Look for "Account Info" section
3. Note down:
   - **Account SID** (starts with "AC...")
   - **Auth Token** (click "Show" to reveal)

## Step 3: Configure the App (2 minutes)

1. Copy the environment template:
```bash
cp .env.example .env
```

2. Open `.env` in your text editor

3. Fill in your credentials:
```bash
MTA_API_KEY=your_mta_key_from_email
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1234567890
PORT=3000
```

## Step 4: Test the MTA API (1 minute)

Run the test script to verify your MTA API key works:

```bash
node test-mta.js
```

You should see bus arrival times for a test stop. If you get an error, double-check your MTA API key in `.env`

## Step 5: Run Locally with ngrok (5 minutes)

### Install ngrok
1. Download from https://ngrok.com/download
2. Extract and run the installer
3. Or use homebrew: `brew install ngrok`

### Start your server
```bash
npm start
```

You should see:
```
🚌 NYC Bus SMS Service running on port 3000
```

### Expose it with ngrok (in a new terminal)
```bash
ngrok http 3000
```

Copy the **HTTPS** URL (looks like `https://abc123.ngrok.io`)

## Step 6: Configure Twilio Webhook (2 minutes)

1. Go to https://console.twilio.com/
2. Navigate to **Phone Numbers** → **Manage** → **Active numbers**
3. Click on your phone number
4. Scroll to "Messaging Configuration"
5. Under "A MESSAGE COMES IN":
   - Webhook: `https://your-ngrok-url.ngrok.io/sms`
   - HTTP: `POST`
6. Click **Save**

## Step 7: Test It!

Text your Twilio phone number:

```
308209
```

You should get back bus arrival times! 🎉

### Try these too:
- `308209 B63` - Filter by route
- `R` - Refresh last query

## Finding Your Own Bus Stops

1. Go to https://bustime.mta.info/
2. Search for your address or intersection
3. Find your bus stop
4. Look for the 6-digit code (e.g., "308209")
5. Text that code to your number!

## Troubleshooting

**No response from SMS?**
- Check that ngrok is still running
- Check server logs for errors
- Verify webhook URL in Twilio console

**"No buses found"?**
- Verify the stop code at https://bustime.mta.info/
- Try a different stop
- Some stops might have no buses at night

**API key errors?**
- Wait for the MTA email with your key
- Make sure you copied it correctly to `.env`
- No spaces before or after the key

## Next: Deploy to Production

Once it's working locally, deploy to Railway, Heroku, or another host (see README.md for details).

For production, you'll update the Twilio webhook to your permanent URL instead of the ngrok URL.
