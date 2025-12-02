require('dotenv').config({ path: '.env.local' });
const express = require('express');
const twilio = require('twilio');
const MTABusAPI = require('./mta-api');
const GeminiCalorieAPI = require('./gemini-api');
const { MessageParser, SessionManager } = require('./message-handler');

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

// Twilio webhook endpoint for incoming SMS
app.post('/sms', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMessage = req.body.Body;
  const fromNumber = req.body.From;

  console.log(`Received from ${fromNumber}: ${incomingMessage}`);

  try {
    // Parse the incoming message
    const parsed = parser.parse(incomingMessage);

    let responseText;

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
        break;

      case 'error':
      default:
        responseText = parsed.message || 'Send a food description for calories, or a 6-digit stop code for bus times.';
        break;
    }

    twiml.message(responseText);

  } catch (error) {
    console.error('Error processing message:', error);
    twiml.message('Sorry, there was an error getting bus times. Please try again later.');
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
