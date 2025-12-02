const twilio = require('twilio');

// Import our API clients and message parser
// Vercel serverless functions can import from parent directory
const MTABusAPI = require('../mta-api');
const GeminiCalorieAPI = require('../gemini-api');
const { MessageParser } = require('../message-handler');

module.exports = async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMessage = req.body.Body;
  const fromNumber = req.body.From;

  console.log(`Received from ${fromNumber}: ${incomingMessage}`);

  try {
    // Initialize APIs with keys from environment
    const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
    const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
    const parser = new MessageParser();

    // Parse the incoming message
    const parsed = parser.parse(incomingMessage);

    let responseText;

    switch (parsed.type) {
      case 'refresh':
        // Refresh not supported in serverless without persistent storage
        responseText = 'Refresh not available. Please send your stop code again.';
        break;

      case 'stop_query':
        // Get bus arrivals
        const arrivalData = await mtaAPI.getStopArrivals(parsed.stopCode, parsed.route);
        responseText = mtaAPI.formatAsText(arrivalData);
        // Add footer to make response more conversational
        responseText += '\n\nText "refresh" to update or send another stop code.';
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

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
