const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();
const MCP_BASE_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:3666';

// Uber credentials for email/password login (preferred over SMS)
const UBER_EMAIL = process.env.UBER_EMAIL;
const UBER_PASSWORD = process.env.UBER_PASSWORD;

/**
 * Summarize tool arguments for logging
 */
function summarizeArgs(toolName, args) {
  if (!args) return '';
  switch (toolName) {
    case 'browser_navigate':
      return `"${args.url}"`;
    case 'browser_click':
      return `element="${args.element || args.selector || '?'}"`;
    case 'browser_type':
      return `"${(args.text || '').substring(0, 30)}${(args.text || '').length > 30 ? '...' : ''}"`;
    case 'browser_snapshot':
      return '';
    case 'browser_wait_for':
      return `${args.selector || args.state || '?'}`;
    case 'browser_fill_form':
      return `${Object.keys(args.fields || {}).length} fields`;
    default:
      const keys = Object.keys(args);
      if (keys.length === 0) return '';
      if (keys.length === 1) return `${keys[0]}=${JSON.stringify(args[keys[0]]).substring(0, 30)}`;
      return `${keys.length} args`;
  }
}

/**
 * Summarize tool result for logging
 */
function summarizeResult(toolName, content) {
  if (!content) return 'null';
  const str = typeof content === 'string' ? content : JSON.stringify(content);

  // Check for errors - show full error message
  if (str.includes('Error:') || str.includes('error":')) {
    const errorMatch = str.match(/Error:\s*([^\n"]+)/);
    if (errorMatch) return `ERROR: ${errorMatch[1]}`;
    // Try to extract error from JSON
    const jsonErrorMatch = str.match(/"error":\s*"([^"]+)"/);
    if (jsonErrorMatch) return `ERROR: ${jsonErrorMatch[1]}`;
    // Show more of the error
    return str.substring(0, 200) + (str.length > 200 ? '...' : '');
  }

  if (str.length <= 100) return str;

  // For snapshots, show element count if available
  if (toolName === 'browser_snapshot') {
    const match = str.match(/"type":/g);
    if (match) return `snapshot (${match.length} elements)`;
  }

  return str.substring(0, 100) + '...';
}

// MCP SDK is ESM-only, use dynamic imports
let Client, StreamableHTTPClientTransport;
async function loadMcpSdk() {
  if (!Client) {
    const clientModule = await import('@modelcontextprotocol/sdk/client');
    const httpModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    Client = clientModule.Client;
    StreamableHTTPClientTransport = httpModule.StreamableHTTPClientTransport;
  }
}

/**
 * Get Uber quote using Claude as the browser automation agent
 * Handles the entire flow including login and SMS code entry if needed
 * @param {string} pickup - Pickup address
 * @param {string} destination - Destination address
 * @param {string|null} smsCode - Optional SMS verification code (if continuing after auth)
 * @returns {Promise<Object>} Quote with price, ETA, addresses
 */
async function getUberQuote(pickup, destination, smsCode = null) {
  console.log(`[UBER] Getting quote: ${pickup} -> ${destination}${smsCode ? ' (with SMS code)' : ''}`);
  const startTime = Date.now();

  // Load MCP SDK (ESM dynamic import)
  await loadMcpSdk();

  // Build the MCP URL (not /sse - that's legacy and returns 403)
  const mcpUrl = new URL('/mcp', MCP_BASE_URL);

  // Connect to Playwright MCP server via Streamable HTTP transport
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  const mcpClient = new Client({ name: 'uber-agent', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);
    console.log(`[UBER] Connected to MCP server`);

    // Get available tools from MCP server
    const { tools } = await mcpClient.listTools();
    console.log(`[UBER] ${tools.length} browser tools available`);

    // Convert MCP tools to Claude API format
    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    const systemPrompt = `You are a browser automation agent. Use the browser tools to navigate Uber's website and get a price quote. DO NOT book or request a ride - only get the price.`;

    const messages = [{
      role: 'user',
      content: `Get an Uber price quote from "${pickup}" to "${destination}".

LOGIN CREDENTIALS:
- Email: ${UBER_EMAIL}
- Password: ${UBER_PASSWORD}
${smsCode ? `\nSMS CODE: ${smsCode}` : ''}

STEPS:
1. Take a snapshot to see current page state
2. If on m.uber.com home page (or no page open), navigate to https://m.uber.com/go/home and enter pickup and destination
3. Dismiss any cookie banners or popups
4. Enter pickup location: ${pickup}
5. Select the first suggestion
6. Enter destination: ${destination}
7. Select the first suggestion
8. If you see a login page:
   a. Enter email: ${UBER_EMAIL}
   b. Click continue
   c. Click "More options" then "Password"
   d. Enter password: ${UBER_PASSWORD}
   e. Click sign in
9. If you see an SMS code input (4-6 digit OTP fields):
${smsCode
  ? `   - Enter the code: ${smsCode}
   - Wait for redirect, then continue to get prices`
  : `   - STOP and return: {"requiresAuth": true, "authType": "sms_code"}`}
10. On product selection page, extract all prices and ETAs
11. DO NOT book - just return the quote

RESPONSE FORMAT - return ONLY JSON, no other text:
{
  "products": [
    {"name": "UberX", "price": "$XX.XX", "eta": "X min"},
    {"name": "Comfort", "price": "$XX.XX", "eta": "X min"},
    ...
  ],
  "pickupAddress": "resolved address",
  "destAddress": "resolved address"
}`
    }];

    // Agent loop - let Claude drive the browser
    let maxIterations = 25;
    while (maxIterations-- > 0) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: claudeTools,
        messages
      });

      // Check if Claude is done (returned final text without tool use)
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(c => c.type === 'text');
        if (textBlock?.text) {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`[UBER] Quote fetched in ${Date.now() - startTime}ms`);
            console.log(`[UBER] Result: ${JSON.stringify(result)}`);

            // Check if auth is required
            if (result.requiresAuth) {
              return {
                requiresAuth: true,
                authType: result.authType || 'sms_code',
                message: result.message || 'SMS code required'
              };
            }

            // Return products array with individual prices
            return {
              products: result.products || [],
              pickup: {
                address: result.pickupAddress || pickup
              },
              destination: {
                address: result.destAddress || destination
              }
            };
          }
        }
        // No JSON found, Claude might be confused
        console.log(`[UBER] No JSON in response: ${textBlock?.text}`);
        break;
      }

      // Execute any tool calls
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        console.log('[UBER] No tool calls in response, breaking');
        break;
      }

      const toolResults = [];
      for (const block of toolUseBlocks) {
        // Log tool call with key arguments
        const argsSummary = summarizeArgs(block.name, block.input);
        console.log(`[UBER] Tool: ${block.name}(${argsSummary})`);

        const toolStart = Date.now();
        try {
          const result = await mcpClient.callTool({ name: block.name, arguments: block.input });
          const resultSummary = summarizeResult(block.name, result.content);
          console.log(`[UBER]   → ${resultSummary} (${Date.now() - toolStart}ms)`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.content)
          });
        } catch (err) {
          console.error(`[UBER]   → ERROR: ${err.message} (${Date.now() - toolStart}ms)`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true
          });
        }
      }

      // Add assistant response and tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error('Max iterations reached without getting a quote');
  } finally {
    try {
      await mcpClient.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

/**
 * Parse price string like "$54.51" to number 54.51
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const match = priceStr.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Confirm and book an Uber ride using browser automation
 * @param {Object} pendingRide - Saved ride details from getUberQuote
 * @param {number} productIndex - Index of selected product (0-based)
 * @returns {Promise<Object>} Ride confirmation details
 */
async function confirmUberRide(pendingRide, productIndex = 0) {
  const product = pendingRide.products?.[productIndex];
  if (!product) {
    throw new Error('Invalid product selection');
  }

  const quotedPrice = parsePrice(product.price);
  console.log(`[UBER] Confirming ${product.name} for ${product.price} to ${pendingRide.destination.address}`);
  const startTime = Date.now();

  // Load MCP SDK (ESM dynamic import)
  await loadMcpSdk();

  const mcpUrl = new URL('/mcp', MCP_BASE_URL);
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  const mcpClient = new Client({ name: 'uber-confirm-agent', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);
    console.log(`[UBER] Connected to MCP server for booking`);

    const { tools } = await mcpClient.listTools();
    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    const systemPrompt = `You are a browser automation agent. Use the browser tools to book an Uber ride. You MUST verify the price before confirming.`;

    const messages = [{
      role: 'user',
      content: `Book an Uber ${product.name} ride.

CRITICAL PRICE CHECK:
- Quoted price: ${product.price}
- Maximum allowed price: $${(quotedPrice + 3).toFixed(2)}
- If current price exceeds maximum, DO NOT BOOK. Return error.

EXPECTED STATE:
- Browser should already be on Uber product selection page
- From: ${pendingRide.pickup.address}
- To: ${pendingRide.destination.address}

STEPS:
1. Take a snapshot to see current page state
2. If not on product selection page, navigate to https://m.uber.com/go/home and re-enter:
   - Pickup: ${pendingRide.pickup.address}
   - Destination: ${pendingRide.destination.address}
3. Find and select the "${product.name}" product option
4. IMPORTANT: Check the current price shown for ${product.name}
   - Extract the exact price shown on the page
   - If price > $${(quotedPrice + 3).toFixed(2)}, STOP and return error
5. Click the "Request ${product.name}" or "Confirm" button
6. Wait for driver assignment (may take 10-30 seconds)
7. Extract driver and vehicle info from confirmation screen

RESPONSE FORMAT - return ONLY JSON:
{
  "success": true,
  "currentPrice": "$XX.XX",
  "driverName": "Driver Name",
  "vehicle": "Vehicle Make Model - License Plate",
  "eta": "X min",
  "requestId": "if visible"
}

OR if price exceeded:
{
  "success": false,
  "error": "price_exceeded",
  "quotedPrice": "${product.price}",
  "currentPrice": "$XX.XX",
  "message": "Price increased from ${product.price} to $XX.XX (exceeds $3 tolerance)"
}

OR if booking failed:
{
  "success": false,
  "error": "booking_failed",
  "message": "reason for failure"
}`
    }];

    // Agent loop
    let maxIterations = 30;
    while (maxIterations-- > 0) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: claudeTools,
        messages
      });

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(c => c.type === 'text');
        if (textBlock?.text) {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`[UBER] Booking completed in ${Date.now() - startTime}ms`);
            console.log(`[UBER] Result: ${JSON.stringify(result)}`);

            if (!result.success) {
              if (result.error === 'price_exceeded') {
                throw new Error(`Price increased to ${result.currentPrice} (was ${product.price}). Booking cancelled.`);
              }
              throw new Error(result.message || 'Booking failed');
            }

            return {
              requestId: result.requestId || `uber-${Date.now()}`,
              driverName: result.driverName || 'Driver assigned',
              vehicle: result.vehicle || 'Vehicle assigned',
              eta: result.eta || 'Arriving soon',
              price: result.currentPrice || product.price
            };
          }
        }
        console.log(`[UBER] No JSON in booking response: ${textBlock?.text}`);
        break;
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        console.log('[UBER] No tool calls in response, breaking');
        break;
      }

      const toolResults = [];
      for (const block of toolUseBlocks) {
        const argsSummary = summarizeArgs(block.name, block.input);
        console.log(`[UBER] Tool: ${block.name}(${argsSummary})`);

        const toolStart = Date.now();
        try {
          const result = await mcpClient.callTool({ name: block.name, arguments: block.input });
          const resultSummary = summarizeResult(block.name, result.content);
          console.log(`[UBER]   → ${resultSummary} (${Date.now() - toolStart}ms)`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.content)
          });
        } catch (err) {
          console.error(`[UBER]   → ERROR: ${err.message} (${Date.now() - toolStart}ms)`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error('Max iterations reached without completing booking');
  } finally {
    try {
      await mcpClient.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

/**
 * Get status of an active Uber ride
 * @param {string} requestId - The ride request ID
 * @returns {Promise<Object>} Ride status
 */
async function getUberStatus(requestId) {
  console.log(`[UBER] Getting status for ride ${requestId}`);
  throw new Error('Uber status requires app login. Check your Uber app for updates.');
}

/**
 * Cancel an active Uber ride
 * @param {string} requestId - The ride request ID
 */
async function cancelUberRide(requestId) {
  console.log(`[UBER] Canceling ride ${requestId}`);
  throw new Error('Uber cancellation requires app login. Cancel in your Uber app.');
}

module.exports = {
  getUberQuote,
  confirmUberRide,
  getUberStatus,
  cancelUberRide
};
