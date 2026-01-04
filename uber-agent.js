const { chromium } = require('playwright');

// Path to store browser session (cookies, localStorage)
const SESSION_FILE = '/tmp/uber-session.json';

/**
 * Get a browser context with saved session (if available)
 */
async function getBrowserContext(browser) {
  const fs = require('fs');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7580, longitude: -73.9855 }, // Times Square
    permissions: ['geolocation'],
    javaScriptEnabled: true
  });

  // Try to load saved session
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      await context.addCookies(sessionData.cookies || []);
      console.log('[UBER] Loaded saved session');
    }
  } catch (err) {
    console.log('[UBER] No saved session found, starting fresh');
  }

  return context;
}

/**
 * Save browser session for reuse
 */
async function saveSession(context) {
  const fs = require('fs');

  try {
    const cookies = await context.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies }));
    console.log('[UBER] Session saved');
  } catch (err) {
    console.error('[UBER] Failed to save session:', err.message);
  }
}

/**
 * Get Uber quote by automating the web interface
 * @param {string} pickup - Pickup address
 * @param {string} destination - Destination address
 * @returns {Promise<Object>} Quote with price, ETA, addresses
 */
async function getUberQuote(pickup, destination) {
  console.log(`[UBER] Getting quote: ${pickup} -> ${destination}`);
  const startTime = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const context = await getBrowserContext(browser);
    const page = await context.newPage();

    // Navigate to Uber's mobile web page (more reliable than desktop)
    await page.goto('https://m.uber.com/go/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);
    console.log(`[UBER] Page loaded in ${Date.now() - startTime}ms`);

    // Dismiss cookie banner if present
    try {
      const gotItButton = await page.$('button:has-text("Got it")');
      if (gotItButton) await gotItButton.click();
    } catch (e) { /* ignore */ }

    // Click on pickup location field
    const pickupField = await page.waitForSelector('text=Pickup location', { timeout: 10000 });
    await pickupField.click();
    await page.waitForTimeout(500);

    // Type pickup address
    await page.keyboard.type(pickup, { delay: 30 });
    await page.waitForTimeout(2000);

    // Select first suggestion using keyboard
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // Now click on dropoff field
    const dropoffField = await page.waitForSelector('text=Dropoff location', { timeout: 10000 });
    await dropoffField.click();
    await page.waitForTimeout(500);

    // Type destination
    await page.keyboard.type(destination, { delay: 30 });
    await page.waitForTimeout(2000);

    // Select first suggestion
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    // Click "Search" button to trigger price lookup
    const searchBtn = await page.$('button:has-text("Search")');
    if (searchBtn) {
      await searchBtn.click();
      await page.waitForTimeout(6000);
    }

    // Extract ride options and check if login is required
    const quoteData = await page.evaluate(() => {
      const body = document.body.innerText;

      // Check if login is required
      const requiresLogin = body.includes('Log in to see ride options') ||
                           body.includes('log in or sign up');

      // Extract price (look for $XX or $XX-$YY patterns)
      const priceMatch = body.match(/\$\d+(?:\.\d{2})?(?:\s*[-–]\s*\$\d+(?:\.\d{2})?)?/);
      const price = priceMatch ? priceMatch[0] : null;

      // Look for ETA (X min away or X-Y min)
      const etaMatch = body.match(/(\d+(?:\s*[-–]\s*\d+)?)\s*min/i);
      const eta = etaMatch ? etaMatch[0] : null;

      // Get available products
      const products = [];
      const productPatterns = ['UberX', 'UberXL', 'Black', 'Comfort', 'Electric', 'Pool', 'UberXXL'];
      for (const p of productPatterns) {
        if (body.includes(p) && !products.includes(p)) {
          products.push(p);
        }
      }

      // Get pickup and dropoff from page
      const fromMatch = body.match(/From ([^\n]+)/);
      const toMatch = body.match(/To ([^\n]+)/);

      return {
        price,
        eta,
        products,
        requiresLogin,
        pickupAddress: fromMatch ? fromMatch[1].trim() : null,
        destAddress: toMatch ? toMatch[1].trim() : null
      };
    });

    await saveSession(context);
    console.log(`[UBER] Quote fetched in ${Date.now() - startTime}ms`);
    console.log(`[UBER] Data: ${JSON.stringify(quoteData)}`);

    // If login required but we have ride options, still return useful info
    if (quoteData.requiresLogin && !quoteData.price) {
      return {
        productId: 'uberx',
        productName: quoteData.products.length > 0 ? quoteData.products[0] : 'UberX',
        priceEstimate: 'Login required for price',
        eta: quoteData.eta || 'varies',
        availableProducts: quoteData.products,
        requiresLogin: true,
        pickup: {
          address: quoteData.pickupAddress || pickup,
          lat: 0,
          lng: 0
        },
        destination: {
          address: quoteData.destAddress || destination,
          lat: 0,
          lng: 0
        }
      };
    }

    return {
      productId: 'uberx',
      productName: quoteData.products.length > 0 ? quoteData.products[0] : 'UberX',
      priceEstimate: quoteData.price || 'Price unavailable',
      eta: quoteData.eta || '5-10 min',
      pickup: {
        address: quoteData.pickupAddress || pickup,
        lat: 0,
        lng: 0
      },
      destination: {
        address: quoteData.destAddress || destination,
        lat: 0,
        lng: 0
      }
    };

  } finally {
    await browser.close();
  }
}

/**
 * Confirm and book an Uber ride
 * NOTE: This requires the user to be logged in. For now, returns a placeholder.
 * Real implementation would need to handle Uber login flow.
 * @param {Object} pendingRide - Saved ride details from getUberQuote
 * @returns {Promise<Object>} Ride confirmation details
 */
async function confirmUberRide(pendingRide) {
  console.log(`[UBER] Confirming ride to ${pendingRide.destination.address}`);

  // For now, we can't actually book without login
  // Return an error explaining the situation
  throw new Error('Uber booking requires login. Feature coming soon. Please book directly in Uber app.');
}

/**
 * Get status of an active Uber ride
 * @param {string} requestId - The ride request ID
 * @returns {Promise<Object>} Ride status
 */
async function getUberStatus(requestId) {
  console.log(`[UBER] Getting status for ride ${requestId}`);

  // Without API access, we can't get real-time status
  throw new Error('Uber status requires app login. Check your Uber app for updates.');
}

/**
 * Cancel an active Uber ride
 * @param {string} requestId - The ride request ID
 */
async function cancelUberRide(requestId) {
  console.log(`[UBER] Canceling ride ${requestId}`);

  // Without API access, we can't cancel
  throw new Error('Uber cancellation requires app login. Cancel in your Uber app.');
}

module.exports = {
  getUberQuote,
  confirmUberRide,
  getUberStatus,
  cancelUberRide
};
