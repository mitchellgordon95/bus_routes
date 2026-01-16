const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();
const MCP_BASE_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:3666';

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
 * @param {string} pickup - Pickup address
 * @param {string} destination - Destination address
 * @param {string} userPhone - User's phone number for auto-login (optional)
 * @returns {Promise<Object>} Quote with price, ETA, addresses, or requiresAuth flag
 */
async function getUberQuote(pickup, destination, userPhone = null) {
  console.log(`[UBER] Getting quote: ${pickup} -> ${destination}`);
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

    const systemPrompt = `You are a browser automation agent. You have access to tools that let you control a web browser.
Use the browser tools to navigate Uber's website and get a price quote.
Be patient - wait for elements to load before interacting with them.
If you see a cookie banner or popup, dismiss it first.

AUTH HANDLING:
If you encounter a login/sign-in page:
1. If you see a phone number input field and userPhone is provided, enter the phone number and submit
2. If you see an SMS code/verification code input (after phone was entered), STOP and return:
   {"requiresAuth": true, "authType": "sms_code", "message": "SMS code required"}
3. Do NOT try to guess or make up verification codes`;

    const messages = [{
      role: 'user',
      content: `Get an Uber price quote from "${pickup}" to "${destination}".
${userPhone ? `User phone for login (if needed): ${userPhone}` : 'No phone provided for login.'}

Steps:
1. Navigate to https://m.uber.com/go/home
2. Wait for the page to fully load
3. If there's a cookie banner or popup, dismiss it
4. If you see a login/sign-in page:
   - If there's a phone input and userPhone is provided, enter it and continue
   - If you see an SMS code input, STOP and return: {"requiresAuth": true, "authType": "sms_code", "message": "SMS code required"}
5. Click the pickup location field and type: ${pickup}
6. Wait for location suggestions to appear
7. Select the first suggestion
8. Click the dropoff/destination field and type: ${destination}
9. Wait for location suggestions to appear
10. Select the first suggestion
11. Click the "Search" or "See prices" button
12. Wait for ride options to load
13. Extract all visible information: prices, ETAs, ride types, addresses

When you have extracted the information, respond with ONLY this JSON format (no other text before or after):
{
  "price": "$XX-XX or null if login required",
  "eta": "X min or null",
  "products": ["UberX", "Comfort", ...],
  "pickupAddress": "resolved address from page",
  "destAddress": "resolved address from page",
  "requiresLogin": true or false
}

If SMS auth is needed, return ONLY:
{"requiresAuth": true, "authType": "sms_code", "message": "SMS code required"}`
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

            // Format response to match existing interface
            return {
              productId: 'uberx',
              productName: result.products?.[0] || 'UberX',
              priceEstimate: result.price || 'Price unavailable',
              eta: result.eta || '5-10 min',
              availableProducts: result.products || [],
              requiresLogin: result.requiresLogin || false,
              pickup: {
                address: result.pickupAddress || pickup,
                lat: 0,
                lng: 0
              },
              destination: {
                address: result.destAddress || destination,
                lat: 0,
                lng: 0
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
 * Enter Uber auth code and continue with the original action
 * @param {string} code - The SMS verification code
 * @param {Object} pendingAuth - Context from savePendingAuth (action, pickup, destination)
 * @param {string} userPhone - User's phone number
 * @returns {Promise<Object>} Result of the continued action
 */
async function enterUberAuthCode(code, pendingAuth, userPhone) {
  console.log(`[UBER] Entering auth code: ${code.substring(0, 2)}****`);
  const startTime = Date.now();

  await loadMcpSdk();

  const mcpUrl = new URL('/mcp', MCP_BASE_URL);
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  const mcpClient = new Client({ name: 'uber-agent', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);
    console.log(`[UBER] Connected to MCP server for auth`);

    const { tools } = await mcpClient.listTools();
    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    const systemPrompt = `You are a browser automation agent. Complete the Uber login by entering the verification code, then proceed with the requested action.`;

    const messages = [{
      role: 'user',
      content: `The browser should have the Uber SMS code verification page open.

Steps:
1. Take a snapshot to see the current page
2. Enter these digits into the OTP fields one at a time: ${code.split('').join(', ')}
3. After entering all 4 digits, click the "Next" button (it should now be enabled)
4. Wait 5 seconds using browser_wait_for for the page to redirect
5. Take a snapshot to check the URL
6. Return JSON based on the URL:

If URL contains "m.uber.com" (not auth.uber.com):
{"success": true, "loggedIn": true, "message": "Login successful"}

If still on auth.uber.com:
{"success": false, "error": "SMS verification failed"}

IMPORTANT: The "Next" button is the correct button to click after entering the SMS code.
DO NOT click "Continue with Google", "Login with email", or "Apple" - those are different login methods.`
    }];

    let maxIterations = 25;
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
            console.log(`[UBER] Auth completed in ${Date.now() - startTime}ms`);
            console.log(`[UBER] Result: ${JSON.stringify(result)}`);

            if (result.success || result.loggedIn) {
              // Auth succeeded - tell user to try their request again
              return { success: true, message: result.message || 'Logged in successfully' };
            } else {
              throw new Error(result.error || 'Auth failed');
            }
          }
        }
        break;
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

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

    throw new Error('Auth code entry failed - max iterations reached');
  } finally {
    try {
      await mcpClient.close();
    } catch (e) {}
  }
}

/**
 * Confirm and book an Uber ride
 * NOTE: This requires the user to be logged in. For now, returns a placeholder.
 * @param {Object} pendingRide - Saved ride details from getUberQuote
 * @returns {Promise<Object>} Ride confirmation details
 */
async function confirmUberRide(pendingRide) {
  console.log(`[UBER] Confirming ride to ${pendingRide.destination.address}`);
  throw new Error('Uber booking requires login. Feature coming soon. Please book directly in Uber app.');
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
  enterUberAuthCode,
  confirmUberRide,
  getUberStatus,
  cancelUberRide
};
