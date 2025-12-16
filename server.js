require('dotenv').config({ path: '.env.local' });
const express = require('express');
const twilio = require('twilio');
const MTABusAPI = require('./mta-api');
const GeminiCalorieAPI = require('./gemini-api');
const { MessageParser, SessionManager } = require('./message-handler');
const { addCalories, subtractCalories, getTodayTotal, resetToday } = require('./calorie-tracker');

const app = express();
const port = process.env.PORT || 3000;

// Initialize services
const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
const parser = new MessageParser();
const sessions = new SessionManager();

// Middleware
app.use(express.urlencoded({ extended: false }));

// Health check endpoint
app.get('/', (req, res) => {
  res.send('NYC Bus SMS Service is running!');
});

/**
 * Fetch image from Twilio MMS URL
 * @param {string} mediaUrl - Twilio media URL
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function fetchTwilioMedia(mediaUrl) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/jpeg';

  return { buffer, contentType };
}

// Twilio webhook endpoint for incoming SMS
app.post('/sms', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMessage = req.body.Body || '';
  const fromNumber = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`Received from ${fromNumber}: ${incomingMessage} (${numMedia} media)`);

  try {
    let responseText;

    // Check for calorie reset command
    if (incomingMessage.toLowerCase().trim() === 'reset calories') {
      const previous = await resetToday();
      responseText = `Daily calories reset. Previous total was ${previous} cal.`;
    }
    // Check for daily total command
    else if (incomingMessage.toLowerCase().trim() === 'total') {
      const total = await getTodayTotal();
      responseText = `Today's total: ${total} cal`;
    }
    // Check for subtract command (e.g., "sub 20")
    else if (/^sub\s+\d+$/i.test(incomingMessage.trim())) {
      const amount = parseInt(incomingMessage.trim().split(/\s+/)[1], 10);
      const newTotal = await subtractCalories(amount);
      responseText = `Subtracted ${amount} cal.\n\nDaily total: ${newTotal} cal`;
    }
    // Check if this is an MMS with an image
    else if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      // Only process image types
      if (mediaType && mediaType.startsWith('image/')) {
        console.log(`Processing image: ${mediaType}`);
        const { buffer, contentType } = await fetchTwilioMedia(mediaUrl);
        const calorieData = await geminiAPI.estimateCaloriesFromImage(
          buffer,
          contentType,
          incomingMessage // Use any accompanying text as context
        );
        responseText = geminiAPI.formatAsText(calorieData);

        // Track calories if estimation succeeded
        if (calorieData.success && calorieData.totalCalories) {
          const dailyTotal = await addCalories(calorieData.totalCalories);
          responseText += `\n\nDaily total: ${dailyTotal} cal`;
        }
      } else {
        responseText = 'Please send a photo of food for calorie estimation, or text a food description.';
      }
    } else {
      // Parse the incoming text message
      const parsed = parser.parse(incomingMessage);

      switch (parsed.type) {
        case 'refresh':
          // Handle refresh command
          const lastQuery = sessions.getLastQuery(fromNumber);
          if (!lastQuery) {
            responseText = 'No recent query to refresh. Text a stop code to get started.';
          } else {
            const data = await mtaAPI.getStopArrivals(lastQuery.stopCode, lastQuery.route);
            responseText = mtaAPI.formatAsText(data);
          }
          break;

        case 'stop_query':
          // Save this query for refresh
          sessions.saveQuery(fromNumber, parsed.stopCode, parsed.route);

          // Get bus arrivals
          const arrivalData = await mtaAPI.getStopArrivals(parsed.stopCode, parsed.route);
          responseText = mtaAPI.formatAsText(arrivalData);
          responseText += '\n\nText R to refresh.';
          break;

        case 'service_changes':
          // Service changes not implemented yet
          responseText = `Service changes for ${parsed.route}: Feature coming soon. Check mta.info for current alerts.`;
          break;

        case 'food_query':
          const calorieData = await geminiAPI.estimateCalories(parsed.foodDescription);
          responseText = geminiAPI.formatAsText(calorieData);

          // Track calories if estimation succeeded
          if (calorieData.success && calorieData.totalCalories) {
            const dailyTotal = await addCalories(calorieData.totalCalories);
            responseText += `\n\nDaily total: ${dailyTotal} cal`;
          }
          break;

        case 'error':
        default:
          responseText = parsed.message || 'Send a food description for calories, or a 6-digit stop code for bus times.';
          break;
      }
    }

    twiml.message(responseText);

  } catch (error) {
    console.error('Error processing message:', error);
    twiml.message('Sorry, there was an error processing your request. Please try again later.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).send('Internal server error');
});

// Start server
app.listen(port, () => {
  console.log(`🚌 NYC Bus SMS Service running on port ${port}`);
  console.log(`📱 Twilio webhook URL: http://your-domain.com/sms`);

  // Validate required environment variables
  if (!process.env.MTA_API_KEY) {
    console.warn('Warning: MTA_API_KEY not set');
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY not set - calorie features disabled');
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('Warning: Twilio credentials not set');
  }
});
