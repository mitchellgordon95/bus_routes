require('dotenv').config({ path: '.env.local' });

const express = require('express');
const twilio = require('twilio');

// Import our API clients and message parser
const MTABusAPI = require('./mta-api');
const GeminiCalorieAPI = require('./gemini-api');
const { MessageParser } = require('./message-handler');
const { addCalories, subtractCalories, getTodayTotal, resetToday, getTarget, setTarget } = require('./calorie-tracker');
const {
  savePendingRide,
  getPendingRide,
  clearPendingRide,
  saveActiveRide,
  getActiveRide,
  clearActiveRide
} = require('./uber-pending');

// Uber agent (browser automation via Claude Agent SDK)
const { getUberQuote, confirmUberRide, getUberStatus, cancelUberRide } = require('./uber-agent');

const app = express();
app.use(express.urlencoded({ extended: false }));

/**
 * Fetch image from Twilio MMS URL
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

/**
 * Main SMS handler
 */
app.post('/sms', async (req, res) => {
  const requestStart = Date.now();
  console.log('=== SMS Request Start ===');

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
        const [total, target] = await Promise.all([getTodayTotal(), getTarget()]);
        console.log(`[TIMING] database-get-total: ${Date.now() - dbStart}ms`);
        responseText = `Today's total: ${total} / ${target} cal`;
        break;
      }

      case 'subtract': {
        const dbStart = Date.now();
        const [newTotal, target] = await Promise.all([subtractCalories(parsed.amount), getTarget()]);
        console.log(`[TIMING] database-subtract: ${Date.now() - dbStart}ms`);
        responseText = `Subtracted ${parsed.amount} cal.\n\nDaily total: ${newTotal} / ${target} cal`;
        break;
      }

      case 'set_target': {
        const dbStart = Date.now();
        const newTarget = await setTarget(parsed.amount);
        console.log(`[TIMING] database-set-target: ${Date.now() - dbStart}ms`);
        responseText = `Daily target set to ${newTarget} cal.`;
        break;
      }

      case 'suggestions': {
        const geminiStart = Date.now();
        responseText = await geminiAPI.getSuggestions(parsed.calories, parsed.descriptors);
        console.log(`[TIMING] gemini-suggestions: ${Date.now() - geminiStart}ms`);
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
          const [dailyTotal, target] = await Promise.all([addCalories(calorieData.totalCalories), getTarget()]);
          console.log(`[TIMING] database-add: ${Date.now() - dbStart}ms`);
          responseText += `\n\nDaily total: ${dailyTotal} / ${target} cal`;
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

      case 'uber_quote': {
        try {
          const uberStart = Date.now();
          const quote = await getUberQuote(parsed.pickup, parsed.destination);
          console.log(`[TIMING] uber-quote-total: ${Date.now() - uberStart}ms`);

          // Save pending ride for confirmation
          await savePendingRide(fromNumber, quote);

          if (quote.requiresLogin) {
            // Login required - show available products but note price unavailable
            const products = quote.availableProducts?.slice(0, 4).join(', ') || 'UberX';
            responseText = `Uber available: ${products}\n\nFrom: ${quote.pickup.address}\nTo: ${quote.destination.address}\n\nPrices require Uber login. Open Uber app to book.`;
          } else {
            responseText = `${quote.productName}: ${quote.priceEstimate}, ${quote.eta} pickup\n\nFrom: ${quote.pickup.address}\nTo: ${quote.destination.address}\n\nReply "uber confirm" to book.`;
          }
        } catch (error) {
          console.error('Uber quote error:', error.message);
          responseText = error.message || 'Could not get Uber quote. Check your addresses.';
        }
        break;
      }

      case 'uber_confirm': {
        // Get pending ride
        const pendingRide = await getPendingRide(fromNumber);
        if (!pendingRide) {
          responseText = 'No pending Uber ride. Text "uber [pickup] to [destination]" first.';
          break;
        }

        try {
          const uberStart = Date.now();
          const ride = await confirmUberRide(pendingRide);
          console.log(`[TIMING] uber-confirm-total: ${Date.now() - uberStart}ms`);

          // Save active ride and clear pending
          await saveActiveRide(fromNumber, ride.requestId);
          await clearPendingRide(fromNumber);

          responseText = `Uber booked!\n\nDriver: ${ride.driverName}\nVehicle: ${ride.vehicle}\nETA: ${ride.eta}\n\nText "uber status" for updates.`;
        } catch (error) {
          console.error('Uber confirm error:', error.message);
          responseText = error.message || 'Could not book Uber. Try again.';
        }
        break;
      }

      case 'uber_status': {
        const activeRequestId = await getActiveRide(fromNumber);
        if (!activeRequestId) {
          // Check for pending ride
          const pending = await getPendingRide(fromNumber);
          if (pending) {
            responseText = `Pending: ${pending.productName} ${pending.priceEstimate}\nFrom: ${pending.pickup.address}\nTo: ${pending.destination.address}\n\nReply "uber confirm" to book.`;
          } else {
            responseText = 'No active Uber ride. Text "uber [pickup] to [destination]" to get started.';
          }
          break;
        }

        try {
          const status = await getUberStatus(activeRequestId);
          responseText = `Uber Status: ${status.status}\n\nDriver: ${status.driverName || 'Assigned'}\nETA: ${status.eta || 'Calculating...'}`;

          // Clear if ride is completed or canceled
          if (['completed', 'rider_canceled', 'driver_canceled'].includes(status.status)) {
            await clearActiveRide(fromNumber);
          }
        } catch (error) {
          console.error('Uber status error:', error.message);
          responseText = 'Could not get ride status.';
        }
        break;
      }

      case 'uber_cancel': {
        // Check for active ride first
        const activeId = await getActiveRide(fromNumber);
        if (activeId) {
          try {
            await cancelUberRide(activeId);
            await clearActiveRide(fromNumber);
            responseText = 'Uber ride canceled.';
          } catch (error) {
            console.error('Uber cancel error:', error.message);
            responseText = error.message || 'Could not cancel ride.';
          }
          break;
        }

        // Check for pending ride
        const pendingToCancel = await getPendingRide(fromNumber);
        if (pendingToCancel) {
          await clearPendingRide(fromNumber);
          responseText = 'Pending Uber request cleared.';
          break;
        }

        responseText = 'No active or pending Uber ride to cancel.';
        break;
      }

      case 'food_query': {
        const geminiStart = Date.now();
        const calorieData = await geminiAPI.estimateCalories(parsed.foodDescription);
        console.log(`[TIMING] gemini-text-api: ${Date.now() - geminiStart}ms`);
        responseText = geminiAPI.formatAsText(calorieData);

        if (calorieData.success && calorieData.totalCalories) {
          const dbStart = Date.now();
          const [dailyTotal, target] = await Promise.all([addCalories(calorieData.totalCalories), getTarget()]);
          console.log(`[TIMING] database-add: ${Date.now() - dbStart}ms`);
          responseText += `\n\nDaily total: ${dailyTotal} / ${target} cal`;
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
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
