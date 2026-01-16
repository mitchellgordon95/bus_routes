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
  clearActiveRide,
  savePendingAuth,
  getPendingAuth,
  clearPendingAuth
} = require('./uber-pending');

// Uber agent (browser automation via Claude Agent SDK)
const { getUberQuote, enterUberAuthCode, confirmUberRide, getUberStatus, cancelUberRide } = require('./uber-agent');

const app = express();
app.use(express.urlencoded({ extended: false }));

// Initialize Twilio client for sending async SMS responses
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send SMS asynchronously (for long-running operations that exceed webhook timeout)
 */
async function sendAsyncSMS(to, from, body) {
  try {
    await twilioClient.messages.create({ body, to, from });
    console.log(`[ASYNC SMS] Sent to ${to}`);
  } catch (error) {
    console.error('[ASYNC SMS] Failed:', error.message);
  }
}

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
        const twilioNumber = req.body.To;

        // Send immediate acknowledgment (avoids Twilio 15s timeout)
        twiml.message('Getting Uber quote... (this may take a moment)');

        // Run async - don't await
        (async () => {
          const uberStart = Date.now();
          try {
            // Pass user's phone for auto-login if needed
            const quote = await getUberQuote(parsed.pickup, parsed.destination, fromNumber);
            console.log(`[TIMING] uber-quote-total: ${Date.now() - uberStart}ms`);

            // Check if auth is required (SMS code needed)
            if (quote.requiresAuth) {
              await savePendingAuth(fromNumber, 'quote', {
                pickup: parsed.pickup,
                destination: parsed.destination
              });
              await sendAsyncSMS(fromNumber, twilioNumber,
                'Uber needs SMS verification. Check your texts from Uber, then reply: uber auth <code>');
              return;
            }

            await savePendingRide(fromNumber, quote);

            let msg;
            if (quote.requiresLogin) {
              const products = quote.availableProducts?.slice(0, 4).join(', ') || 'UberX';
              msg = `Uber available: ${products}\n\nFrom: ${quote.pickup.address}\nTo: ${quote.destination.address}\n\nPrices require Uber login. Open Uber app to book.`;
            } else {
              msg = `${quote.productName}: ${quote.priceEstimate}, ${quote.eta} pickup\n\nFrom: ${quote.pickup.address}\nTo: ${quote.destination.address}\n\nReply "uber confirm" to book.`;
            }

            await sendAsyncSMS(fromNumber, twilioNumber, msg);
          } catch (error) {
            console.error('Uber quote error:', error.message);
            await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not get Uber quote. Check your addresses.');
          }
        })();

        // Return immediately - response will be sent via async SMS
        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml.toString());
        return;
      }

      case 'uber_confirm': {
        // Get pending ride (fast DB lookup)
        const pendingRide = await getPendingRide(fromNumber);
        if (!pendingRide) {
          responseText = 'No pending Uber ride. Text "uber [pickup] to [destination]" first.';
          break;
        }

        const twilioNumber = req.body.To;

        // Send immediate acknowledgment
        twiml.message('Booking your Uber... (this may take a moment)');

        // Run async - don't await
        (async () => {
          const uberStart = Date.now();
          try {
            const ride = await confirmUberRide(pendingRide);
            console.log(`[TIMING] uber-confirm-total: ${Date.now() - uberStart}ms`);

            await saveActiveRide(fromNumber, ride.requestId);
            await clearPendingRide(fromNumber);

            await sendAsyncSMS(fromNumber, twilioNumber,
              `Uber booked!\n\nDriver: ${ride.driverName}\nVehicle: ${ride.vehicle}\nETA: ${ride.eta}\n\nText "uber status" for updates.`);
          } catch (error) {
            console.error('Uber confirm error:', error.message);
            await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not book Uber. Try again.');
          }
        })();

        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml.toString());
        return;
      }

      case 'uber_status': {
        const activeRequestId = await getActiveRide(fromNumber);
        if (!activeRequestId) {
          // Check for pending ride (fast DB lookup - respond synchronously)
          const pending = await getPendingRide(fromNumber);
          if (pending) {
            responseText = `Pending: ${pending.productName} ${pending.priceEstimate}\nFrom: ${pending.pickup.address}\nTo: ${pending.destination.address}\n\nReply "uber confirm" to book.`;
          } else {
            responseText = 'No active Uber ride. Text "uber [pickup] to [destination]" to get started.';
          }
          break;
        }

        const twilioNumber = req.body.To;

        // Send immediate acknowledgment
        twiml.message('Checking ride status...');

        // Run async - don't await (getUberStatus uses browser automation)
        (async () => {
          try {
            const status = await getUberStatus(activeRequestId);
            const msg = `Uber Status: ${status.status}\n\nDriver: ${status.driverName || 'Assigned'}\nETA: ${status.eta || 'Calculating...'}`;

            if (['completed', 'rider_canceled', 'driver_canceled'].includes(status.status)) {
              await clearActiveRide(fromNumber);
            }

            await sendAsyncSMS(fromNumber, twilioNumber, msg);
          } catch (error) {
            console.error('Uber status error:', error.message);
            await sendAsyncSMS(fromNumber, twilioNumber, 'Could not get ride status.');
          }
        })();

        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml.toString());
        return;
      }

      case 'uber_cancel': {
        // Check for active ride first (fast DB lookup)
        const activeId = await getActiveRide(fromNumber);
        if (activeId) {
          const twilioNumber = req.body.To;

          // Send immediate acknowledgment
          twiml.message('Canceling your Uber...');

          // Run async - cancelUberRide uses browser automation
          (async () => {
            try {
              await cancelUberRide(activeId);
              await clearActiveRide(fromNumber);
              await sendAsyncSMS(fromNumber, twilioNumber, 'Uber ride canceled.');
            } catch (error) {
              console.error('Uber cancel error:', error.message);
              await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not cancel ride.');
            }
          })();

          res.setHeader('Content-Type', 'text/xml');
          res.status(200).send(twiml.toString());
          return;
        }

        // Check for pending ride (fast DB operations - respond synchronously)
        const pendingToCancel = await getPendingRide(fromNumber);
        if (pendingToCancel) {
          await clearPendingRide(fromNumber);
          responseText = 'Pending Uber request cleared.';
          break;
        }

        responseText = 'No active or pending Uber ride to cancel.';
        break;
      }

      case 'uber_auth': {
        // Get pending auth (validates there's an auth flow in progress)
        const pendingAuth = await getPendingAuth(fromNumber);
        if (!pendingAuth) {
          responseText = 'No pending Uber auth. Request a ride first with "uber [pickup] to [destination]".';
          break;
        }

        const twilioNumber = req.body.To;

        // Send immediate acknowledgment
        twiml.message('Entering auth code...');

        // Run async
        (async () => {
          try {
            const result = await enterUberAuthCode(parsed.code, pendingAuth, fromNumber);
            await clearPendingAuth(fromNumber);

            if (result.pickup) {
              // Got a quote after auth
              await savePendingRide(fromNumber, result);
              const msg = result.requiresLogin
                ? `Uber available: ${result.availableProducts?.slice(0, 4).join(', ') || 'UberX'}\n\nFrom: ${result.pickup.address}\nTo: ${result.destination.address}\n\nPrices require Uber login.`
                : `${result.productName}: ${result.priceEstimate}, ${result.eta} pickup\n\nFrom: ${result.pickup.address}\nTo: ${result.destination.address}\n\nReply "uber confirm" to book.`;
              await sendAsyncSMS(fromNumber, twilioNumber, msg);
            } else {
              // Just logged in
              await sendAsyncSMS(fromNumber, twilioNumber,
                'Logged into Uber! Now try your request again.');
            }
          } catch (error) {
            console.error('Uber auth error:', error.message);
            await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Auth failed. Try again.');
          }
        })();

        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml.toString());
        return;
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
const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
