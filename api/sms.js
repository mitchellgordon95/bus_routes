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

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
