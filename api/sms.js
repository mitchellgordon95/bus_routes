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

    let responseText;

    // Check for calorie reset command
    if (incomingMessage.toLowerCase().trim() === 'reset calories') {
      const dbStart = Date.now();
      const previous = await resetToday();
      console.log(`[TIMING] database-reset: ${Date.now() - dbStart}ms`);
      responseText = `Daily calories reset. Previous total was ${previous} cal.`;
    }
    // Check for daily total command
    else if (incomingMessage.toLowerCase().trim() === 'total') {
      const dbStart = Date.now();
      const total = await getTodayTotal();
      console.log(`[TIMING] database-get-total: ${Date.now() - dbStart}ms`);
      responseText = `Today's total: ${total} cal`;
    }
    // Check for subtract command (e.g., "sub 20")
    else if (/^sub\s+\d+$/i.test(incomingMessage.trim())) {
      const amount = parseInt(incomingMessage.trim().split(/\s+/)[1], 10);
      const dbStart = Date.now();
      const newTotal = await subtractCalories(amount);
      console.log(`[TIMING] database-subtract: ${Date.now() - dbStart}ms`);
      responseText = `Subtracted ${amount} cal.\n\nDaily total: ${newTotal} cal`;
    }
    // Check if this is an MMS with an image
    else if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      // Only process image types
      if (mediaType && mediaType.startsWith('image/')) {
        console.log(`Processing image: ${mediaType}`);

        const fetchStart = Date.now();
        const { buffer, contentType } = await fetchTwilioMedia(mediaUrl);
        console.log(`[TIMING] twilio-media-fetch: ${Date.now() - fetchStart}ms`);

        const geminiStart = Date.now();
        const calorieData = await geminiAPI.estimateCaloriesFromImage(
          buffer,
          contentType,
          incomingMessage // Use any accompanying text as context
        );
        console.log(`[TIMING] gemini-image-api: ${Date.now() - geminiStart}ms`);

        responseText = geminiAPI.formatAsText(calorieData);

        // Track calories if estimation succeeded
        if (calorieData.success && calorieData.totalCalories) {
          const dbStart = Date.now();
          const dailyTotal = await addCalories(calorieData.totalCalories);
          console.log(`[TIMING] database-add: ${Date.now() - dbStart}ms`);
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
          // Refresh not supported in serverless without persistent storage
          responseText = 'Refresh not available. Please send your stop code again.';
          break;

        case 'stop_query':
          // Get bus arrivals
          const mtaStart = Date.now();
          const arrivalData = await mtaAPI.getStopArrivals(parsed.stopCode, parsed.route);
          console.log(`[TIMING] mta-api: ${Date.now() - mtaStart}ms`);
          responseText = mtaAPI.formatAsText(arrivalData);
          // Add footer to make response more conversational
          responseText += '\n\nText "refresh" to update or send another stop code.';
          break;

        case 'service_changes':
          // Service changes not implemented yet
          responseText = `Service changes for ${parsed.route}: Feature coming soon. Check mta.info for current alerts.`;
          break;

        case 'food_query':
          const geminiTextStart = Date.now();
          const calorieData = await geminiAPI.estimateCalories(parsed.foodDescription);
          console.log(`[TIMING] gemini-text-api: ${Date.now() - geminiTextStart}ms`);
          responseText = geminiAPI.formatAsText(calorieData);

          // Track calories if estimation succeeded
          if (calorieData.success && calorieData.totalCalories) {
            const dbTextStart = Date.now();
            const dailyTotal = await addCalories(calorieData.totalCalories);
            console.log(`[TIMING] database-add: ${Date.now() - dbTextStart}ms`);
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

  console.log(`[TIMING] total-request: ${Date.now() - requestStart}ms`);
  console.log('=== SMS Request End ===');

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
