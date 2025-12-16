const twilio = require('twilio');

// Import our API clients and message parser
// Vercel serverless functions can import from parent directory
const MTABusAPI = require('../mta-api');
const GeminiCalorieAPI = require('../gemini-api');
const { MessageParser } = require('../message-handler');
const { addCalories, subtractCalories, getTodayTotal, resetToday } = require('../calorie-tracker');

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

module.exports = async (req, res) => {
  const requestStart = Date.now();
  console.log('=== SMS Request Start ===');

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMessage = req.body.Body || '';
  const fromNumber = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`Received from ${fromNumber}: ${incomingMessage} (${numMedia} media)`);

  try {
    // Initialize APIs with keys from environment
    const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
    const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
    const parser = new MessageParser();

    // Parse message through unified router
    const parsed = parser.parse(incomingMessage, numMedia > 0, req.body.MediaContentType0);
    let responseText;

    switch (parsed.type) {
      case 'help':
        responseText = parser.getHelpText();
        break;

      case 'reset_calories': {
        const dbStart = Date.now();
        const previous = await resetToday();
        console.log(`[TIMING] database-reset: ${Date.now() - dbStart}ms`);
        responseText = `Daily calories reset. Previous total was ${previous} cal.`;
        break;
      }

      case 'total': {
        const dbStart = Date.now();
        const total = await getTodayTotal();
        console.log(`[TIMING] database-get-total: ${Date.now() - dbStart}ms`);
        responseText = `Today's total: ${total} cal`;
        break;
      }

      case 'subtract': {
        const dbStart = Date.now();
        const newTotal = await subtractCalories(parsed.amount);
        console.log(`[TIMING] database-subtract: ${Date.now() - dbStart}ms`);
        responseText = `Subtracted ${parsed.amount} cal.\n\nDaily total: ${newTotal} cal`;
        break;
      }

      case 'image_calorie': {
        const mediaUrl = req.body.MediaUrl0;
        const mediaType = req.body.MediaContentType0;
        console.log(`Processing image: ${mediaType}`);

        const fetchStart = Date.now();
        const { buffer, contentType } = await fetchTwilioMedia(mediaUrl);
        console.log(`[TIMING] twilio-media-fetch: ${Date.now() - fetchStart}ms`);

        const geminiStart = Date.now();
        const calorieData = await geminiAPI.estimateCaloriesFromImage(
          buffer,
          contentType,
          parsed.textContext
        );
        console.log(`[TIMING] gemini-image-api: ${Date.now() - geminiStart}ms`);

        responseText = geminiAPI.formatAsText(calorieData);

        if (calorieData.success && calorieData.totalCalories) {
          const dbStart = Date.now();
          const dailyTotal = await addCalories(calorieData.totalCalories);
          console.log(`[TIMING] database-add: ${Date.now() - dbStart}ms`);
          responseText += `\n\nDaily total: ${dailyTotal} cal`;
        }
        break;
      }

      case 'refresh':
        responseText = 'Refresh not available. Please send your stop code again.';
        break;

      case 'stop_query': {
        const mtaStart = Date.now();
        const arrivalData = await mtaAPI.getStopArrivals(parsed.stopCode, parsed.route);
        console.log(`[TIMING] mta-api: ${Date.now() - mtaStart}ms`);
        responseText = mtaAPI.formatAsText(arrivalData);
        responseText += '\n\nText "how" for all commands.';
        break;
      }

      case 'service_changes':
        responseText = `Service changes for ${parsed.route}: Feature coming soon. Check mta.info for current alerts.`;
        break;

      case 'food_query': {
        const geminiStart = Date.now();
        const calorieData = await geminiAPI.estimateCalories(parsed.foodDescription);
        console.log(`[TIMING] gemini-text-api: ${Date.now() - geminiStart}ms`);
        responseText = geminiAPI.formatAsText(calorieData);

        if (calorieData.success && calorieData.totalCalories) {
          const dbStart = Date.now();
          const dailyTotal = await addCalories(calorieData.totalCalories);
          console.log(`[TIMING] database-add: ${Date.now() - dbStart}ms`);
          responseText += `\n\nDaily total: ${dailyTotal} cal`;
        }
        break;
      }

      case 'error':
      default:
        responseText = parsed.message || 'Send "how" for available commands.';
        break;
    }

    twiml.message(responseText);

  } catch (error) {
    console.error('Error processing message:', error);
    twiml.message('Sorry, there was an error processing your request. Please try again later.');
  }

  console.log(`[TIMING] total-request: ${Date.now() - requestStart}ms`);
  console.log('=== SMS Request End ===');

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
