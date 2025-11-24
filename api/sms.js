const twilio = require('twilio');

// Import our MTA API client and message parser
// Vercel serverless functions can import from parent directory
const MTABusAPI = require('../mta-api');
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
    // Initialize MTA API with key from environment
    const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
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
        break;

      case 'service_changes':
        // Service changes not implemented yet
        responseText = `Service changes for ${parsed.route}: Feature coming soon. Check mta.info for current alerts.`;
        break;

      case 'error':
      default:
        responseText = parsed.message || 'Invalid request. Text a 6-digit stop code (e.g., "308209" or "308209 B63")';
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
