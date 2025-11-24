# Deploy to Vercel (Easiest Option!)

Deploy your NYC Bus SMS service to Vercel in under 5 minutes.

## Why Vercel?

- ✅ **Free tier** - No credit card required
- ✅ **One-click deploy** - From GitHub
- ✅ **Automatic HTTPS** - Built-in SSL
- ✅ **Zero config** - Works out of the box
- ✅ **Fast** - Edge network globally

## Prerequisites

You'll need:
1. MTA API Key (get at https://register.developer.obanyc.com/)
2. Twilio Account with phone number (https://www.twilio.com/try-twilio)
3. GitHub account

## Step 1: Push to GitHub

### Create a new repo
1. Go to https://github.com/new
2. Name it (e.g., "nyc-bus-sms")
3. Keep it public or private (your choice)
4. **Don't** initialize with README (we already have one)
5. Click "Create repository"

### Push your code
```bash
# In your project directory
git init
git add .
git commit -m "Initial commit - NYC Bus SMS service"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nyc-bus-sms.git
git push -u origin main
```

## Step 2: Deploy to Vercel

### Connect GitHub to Vercel
1. Go to https://vercel.com/signup
2. Click "Continue with GitHub"
3. Authorize Vercel

### Import your project
1. Click "Add New..." → "Project"
2. Find your "nyc-bus-sms" repository
3. Click "Import"

### Configure environment variables
Before deploying, add your secrets:

1. Expand "Environment Variables"
2. Add these three variables:

| Name | Value |
|------|-------|
| `MTA_API_KEY` | Your MTA API key from email |
| `TWILIO_ACCOUNT_SID` | Starts with "AC..." |
| `TWILIO_AUTH_TOKEN` | From Twilio console |

3. Click "Deploy"

Vercel will build and deploy your app. Takes ~2 minutes.

## Step 3: Get Your Webhook URL

Once deployed, Vercel gives you a URL like:
```
https://nyc-bus-sms.vercel.app
```

Your webhook endpoint is:
```
https://nyc-bus-sms.vercel.app/sms
```

Copy this URL!

## Step 4: Configure Twilio

1. Go to https://console.twilio.com/
2. Navigate to **Phone Numbers** → **Manage** → **Active numbers**
3. Click your phone number
4. Scroll to "Messaging Configuration"
5. Under "A MESSAGE COMES IN":
   - Webhook: `https://nyc-bus-sms.vercel.app/sms`
   - HTTP: `POST`
6. Click **Save**

## Step 5: Test It!

Text your Twilio number:
```
308209
```

You should get bus arrival times back! 🎉

## Updating Your App

Vercel automatically redeploys when you push to GitHub:

```bash
# Make your changes, then:
git add .
git commit -m "Update message"
git push
```

Vercel rebuilds and deploys automatically.

## Viewing Logs

To see logs and debug issues:

1. Go to https://vercel.com/dashboard
2. Click your project
3. Click "Deployments"
4. Click the latest deployment
5. Click "Functions" → "api/sms.js"
6. View real-time logs

## Cost

**Vercel Free Tier includes:**
- 100 GB bandwidth/month
- Unlimited API requests
- 100 hours serverless function execution

**For this app:**
- Each SMS query = ~0.1 seconds of function time
- **You can handle ~3.6 million requests/month for free**

The only cost is Twilio (~$0.0079 per message).

## Custom Domain (Optional)

Want to use your own domain?

1. Go to your Vercel project settings
2. Click "Domains"
3. Add your domain (e.g., `bus.yourdomain.com`)
4. Follow DNS instructions
5. Update Twilio webhook to your custom domain

## Troubleshooting

### "No response from SMS"
- Check Vercel logs for errors
- Verify webhook URL in Twilio (must be `/sms` not just `/`)
- Verify environment variables are set

### "MTA API error"
- Check your MTA API key is valid
- View Vercel logs to see the exact error

### "Twilio error"
- Verify webhook is set to POST method
- Check webhook URL has no typos

## Environment Variables

To update environment variables after deployment:

1. Go to your Vercel project
2. Click "Settings" → "Environment Variables"
3. Edit the variable
4. Redeploy (Vercel will prompt you)

## That's It!

Your NYC Bus SMS service is now live on Vercel with:
- ✅ Automatic HTTPS
- ✅ Global CDN
- ✅ Auto-scaling
- ✅ Zero maintenance
- ✅ Free hosting

Pretty easy, right?
