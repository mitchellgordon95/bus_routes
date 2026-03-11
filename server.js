require('dotenv').config({ path: '.env.local' });

const express = require('express');
const twilio = require('twilio');

// Agent-based routing (primary)
const { handleSMS } = require('./sms-agent');

// Regex-based fallback (used when Claude API is unavailable)
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
const { getUberQuote, confirmUberRide, getUberStatus, cancelUberRide } = require('./uber-agent');

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
  const twilioNumber = req.body.To;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`Received from ${fromNumber}: ${incomingMessage} (${numMedia} media)`);

  // Pre-fetch image if MMS
  let imageBuffer = null, imageMediaType = null;
  if (numMedia > 0 && req.body.MediaContentType0?.startsWith('image/')) {
    try {
      const fetchStart = Date.now();
      const media = await fetchTwilioMedia(req.body.MediaUrl0);
      console.log(`[TIMING] twilio-media-fetch: ${Date.now() - fetchStart}ms`);
      imageBuffer = media.buffer;
      imageMediaType = media.contentType;
    } catch (err) {
      console.error('Failed to fetch MMS image:', err.message);
    }
  }

  try {
    // Primary path: Claude agent routing
    const result = await handleSMS({
      message: incomingMessage,
      fromNumber,
      twilioNumber,
      imageBuffer,
      imageMediaType,
      sendAsyncSMS
    });

    twiml.message(result.reply);
  } catch (agentError) {
    // Fallback: regex-based routing (when Claude API is unavailable)
    console.error('[AGENT FALLBACK] Agent failed, using regex:', agentError.message);
    try {
      const responseText = await handleWithRegex(req, fromNumber, twilioNumber, imageBuffer, imageMediaType);

      // handleWithRegex returns null for async operations (already sent TwiML)
      if (responseText === null) {
        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml.toString());
        console.log(`[TIMING] total-request: ${Date.now() - requestStart}ms (fallback, async)`);
        console.log('=== SMS Request End ===');
        return;
      }

      twiml.message(responseText);
    } catch (fallbackError) {
      console.error('[FALLBACK FAILED]', fallbackError.message);
      twiml.message('Sorry, there was an error processing your request. Please try again later.');
    }
  }

  console.log(`[TIMING] total-request: ${Date.now() - requestStart}ms`);
  console.log('=== SMS Request End ===');

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
});

/**
 * Fallback handler using regex-based routing (original MessageParser logic)
 * Used when the Claude agent is unavailable.
 * Returns response text for sync operations, or null for async operations
 * (async operations send their own TwiML via early return patterns).
 */
async function handleWithRegex(req, fromNumber, twilioNumber, imageBuffer, imageMediaType) {
  const incomingMessage = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
  const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
  const parser = new MessageParser();

  const parsed = parser.parse(incomingMessage, numMedia > 0, req.body.MediaContentType0);

  switch (parsed.type) {
    case 'help':
      return parser.getHelpText();

    case 'reset_calories': {
      const previous = await resetToday();
      return `Daily calories reset. Previous total was ${previous} cal.`;
    }

    case 'total': {
      const [total, target] = await Promise.all([getTodayTotal(), getTarget()]);
      return `Today's total: ${total} / ${target} cal`;
    }

    case 'subtract': {
      const [newTotal, target] = await Promise.all([subtractCalories(parsed.amount), getTarget()]);
      return `Subtracted ${parsed.amount} cal.\n\nDaily total: ${newTotal} / ${target} cal`;
    }

    case 'set_target': {
      const newTarget = await setTarget(parsed.amount);
      return `Daily target set to ${newTarget} cal.`;
    }

    case 'suggestions': {
      return await geminiAPI.getSuggestions(parsed.calories, parsed.descriptors);
    }

    case 'image_calorie': {
      if (!imageBuffer) {
        return 'Could not process image. Please try again.';
      }
      const calorieData = await geminiAPI.estimateCaloriesFromImage(
        imageBuffer, imageMediaType, parsed.textContext
      );
      let text = geminiAPI.formatAsText(calorieData);
      if (calorieData.success && calorieData.totalCalories) {
        const [dailyTotal, target] = await Promise.all([addCalories(calorieData.totalCalories), getTarget()]);
        text += `\n\nDaily total: ${dailyTotal} / ${target} cal`;
      }
      return text;
    }

    case 'refresh':
      return 'Refresh not available. Please send your stop code again.';

    case 'stop_query': {
      const arrivalData = await mtaAPI.getStopArrivals(parsed.stopCode, parsed.route);
      return mtaAPI.formatAsText(arrivalData) + '\n\nText "how" for all commands.';
    }

    case 'service_changes':
      return `Service changes for ${parsed.route}: Feature coming soon. Check mta.info for current alerts.`;

    case 'uber_quote': {
      // Fire async, return ack
      (async () => {
        try {
          const quote = await getUberQuote(parsed.pickup, parsed.destination);
          if (quote.requiresAuth) {
            await savePendingAuth(fromNumber, 'quote', { pickup: parsed.pickup, destination: parsed.destination });
            await sendAsyncSMS(fromNumber, twilioNumber, 'Uber needs SMS verification. Check your texts from Uber, then reply: uber auth <code>');
            return;
          }
          await savePendingRide(fromNumber, quote);
          let msg = `Uber from ${quote.pickup.address} to ${quote.destination.address}:\n\n`;
          (quote.products || []).slice(0, 5).forEach((p, i) => { msg += `${i + 1}. ${p.name} - ${p.price} (${p.eta})\n`; });
          msg += quote.products?.length > 0 ? `\nReply "uber confirm 1" to book ${quote.products[0].name}` : 'No products available.';
          await sendAsyncSMS(fromNumber, twilioNumber, msg);
        } catch (error) {
          console.error('Uber quote error:', error.message);
          await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not get Uber quote.');
        }
      })();
      return 'Getting Uber quote... (this may take a moment)';
    }

    case 'uber_confirm': {
      const pendingRide = await getPendingRide(fromNumber);
      if (!pendingRide) return 'No pending Uber ride. Text "uber [pickup] to [destination]" first.';

      const selection = parsed.selection;
      let productIndex = 0;
      if (/^\d+$/.test(selection)) {
        productIndex = parseInt(selection, 10) - 1;
      } else {
        productIndex = pendingRide.products.findIndex(p => p.name.toLowerCase() === selection.toLowerCase());
      }
      if (productIndex < 0 || productIndex >= pendingRide.products.length) {
        return `Invalid selection. Choose 1-${pendingRide.products.length} or product name.`;
      }

      const selectedProduct = pendingRide.products[productIndex];
      (async () => {
        try {
          const ride = await confirmUberRide(pendingRide, productIndex);
          await saveActiveRide(fromNumber, ride.requestId);
          await clearPendingRide(fromNumber);
          await sendAsyncSMS(fromNumber, twilioNumber,
            `Uber booked!\n\nDriver: ${ride.driverName}\nVehicle: ${ride.vehicle}\nETA: ${ride.eta}\n\nText "uber status" for updates.`);
        } catch (error) {
          console.error('Uber confirm error:', error.message);
          await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not book Uber. Try again.');
        }
      })();
      return `Booking ${selectedProduct.name} for ${selectedProduct.price}...`;
    }

    case 'uber_status': {
      const activeRequestId = await getActiveRide(fromNumber);
      if (!activeRequestId) {
        const pending = await getPendingRide(fromNumber);
        if (pending && pending.products?.length > 0) {
          const fp = pending.products[0];
          return `Pending: ${fp.name} ${fp.price}\nFrom: ${pending.pickup.address}\nTo: ${pending.destination.address}\n\nReply "uber confirm" to book.`;
        } else if (pending) {
          return `Pending ride from ${pending.pickup.address} to ${pending.destination.address}\n\nReply "uber confirm" to book.`;
        }
        return 'No active Uber ride. Text "uber [pickup] to [destination]" to get started.';
      }

      (async () => {
        try {
          const status = await getUberStatus(activeRequestId);
          const msg = `Uber Status: ${status.status}\n\nDriver: ${status.driverName || 'Assigned'}\nETA: ${status.eta || 'Calculating...'}`;
          if (['completed', 'rider_canceled', 'driver_canceled'].includes(status.status)) await clearActiveRide(fromNumber);
          await sendAsyncSMS(fromNumber, twilioNumber, msg);
        } catch (error) {
          console.error('Uber status error:', error.message);
          await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Could not get ride status.');
        }
      })();
      return 'Checking ride status...';
    }

    case 'uber_cancel': {
      const activeId = await getActiveRide(fromNumber);
      if (activeId) {
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
        return 'Canceling your Uber...';
      }
      const pendingToCancel = await getPendingRide(fromNumber);
      if (pendingToCancel) {
        await clearPendingRide(fromNumber);
        return 'Pending Uber request cleared.';
      }
      return 'No active or pending Uber ride to cancel.';
    }

    case 'uber_auth': {
      const pendingAuth = await getPendingAuth(fromNumber);
      if (!pendingAuth) return 'No pending Uber auth. Request a ride first with "uber [pickup] to [destination]".';

      (async () => {
        try {
          const quote = await getUberQuote(pendingAuth.pickup, pendingAuth.destination, parsed.code);
          await clearPendingAuth(fromNumber);
          if (quote.requiresAuth) {
            await sendAsyncSMS(fromNumber, twilioNumber, 'Auth still required. Check your texts from Uber and reply: uber auth <code>');
            return;
          }
          await savePendingRide(fromNumber, quote);
          let msg = `Uber from ${quote.pickup.address} to ${quote.destination.address}:\n\n`;
          (quote.products || []).slice(0, 5).forEach((p, i) => { msg += `${i + 1}. ${p.name} - ${p.price} (${p.eta})\n`; });
          msg += quote.products?.length > 0 ? `\nReply "uber confirm 1" to book ${quote.products[0].name}` : 'No products available.';
          await sendAsyncSMS(fromNumber, twilioNumber, msg);
        } catch (error) {
          console.error('Uber auth error:', error.message);
          await sendAsyncSMS(fromNumber, twilioNumber, error.message || 'Auth failed. Try again.');
        }
      })();
      return 'Entering auth code and getting quote...';
    }

    case 'food_query': {
      const calorieData = await geminiAPI.estimateCalories(parsed.foodDescription);
      let text = geminiAPI.formatAsText(calorieData);
      if (calorieData.success && calorieData.totalCalories) {
        const [dailyTotal, target] = await Promise.all([addCalories(calorieData.totalCalories), getTarget()]);
        text += `\n\nDaily total: ${dailyTotal} / ${target} cal`;
      }
      return text;
    }

    case 'error':
    default:
      return parsed.message || 'Send "how" for available commands.';
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Scheduled morning workout SMS
  const cron = require('node-cron');
  const { sendMorningWorkout } = require('./morning-workout');

  cron.schedule('0 8 * * *', () => {
    const toNumber = process.env.MY_PHONE_NUMBER;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!toNumber || !fromNumber) {
      console.log('[CRON] Skipping morning workout - MY_PHONE_NUMBER or TWILIO_PHONE_NUMBER not set');
      return;
    }
    console.log('[CRON] Sending morning workout plan...');
    sendMorningWorkout(sendAsyncSMS, toNumber, fromNumber)
      .catch(err => console.error('[CRON] Morning workout failed:', err.message));
  }, { timezone: 'America/New_York' });

  console.log('Morning workout scheduled for 8:00 AM ET');
});
