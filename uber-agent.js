const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();
const MCP_BASE_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:3666';

// MCP SDK is ESM-only, use dynamic imports
let Client, SSEClientTransport;
async function loadMcpSdk() {
  if (!Client) {
    const clientModule = await import('@modelcontextprotocol/sdk/client');
    const sseModule = await import('@modelcontextprotocol/sdk/client/sse.js');
    Client = clientModule.Client;
    SSEClientTransport = sseModule.SSEClientTransport;
  }
}

/**
 * Get Uber quote using Claude as the browser automation agent
 * @param {string} pickup - Pickup address
 * @param {string} destination - Destination address
 * @returns {Promise<Object>} Quote with price, ETA, addresses
 */
async function getUberQuote(pickup, destination) {
  console.log(`[UBER] Getting quote: ${pickup} -> ${destination}`);
  const startTime = Date.now();

  // Load MCP SDK (ESM dynamic import)
  await loadMcpSdk();

  // Connect to Playwright MCP server via SSE transport
  const transport = new SSEClientTransport(new URL('/sse', MCP_BASE_URL));
  const mcpClient = new Client({ name: 'uber-agent', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);
    console.log(`[UBER] Connected to MCP server at ${MCP_BASE_URL}`);

    // Get available tools from MCP server
    const { tools } = await mcpClient.listTools();
    console.log(`[UBER] MCP tools available: ${tools.map(t => t.name).join(', ')}`);

    // Convert MCP tools to Claude API format
    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    const systemPrompt = `You are a browser automation agent. You have access to tools that let you control a web browser.
Use the browser tools to navigate Uber's website and get a price quote.
Be patient - wait for elements to load before interacting with them.
If you see a cookie banner or popup, dismiss it first.`;

    const messages = [{
      role: 'user',
      content: `Get an Uber price quote from "${pickup}" to "${destination}".

Steps:
1. Navigate to https://m.uber.com/go/home
2. Wait for the page to fully load
3. If there's a cookie banner or popup, dismiss it
4. Click the pickup location field and type: ${pickup}
5. Wait for location suggestions to appear
6. Select the first suggestion
7. Click the dropoff/destination field and type: ${destination}
8. Wait for location suggestions to appear
9. Select the first suggestion
10. Click the "Search" or "See prices" button
11. Wait for ride options to load
12. Extract all visible information: prices, ETAs, ride types, addresses

When you have extracted the information, respond with ONLY this JSON format (no other text before or after):
{
  "price": "$XX-XX or null if login required",
  "eta": "X min or null",
  "products": ["UberX", "Comfort", ...],
  "pickupAddress": "resolved address from page",
  "destAddress": "resolved address from page",
  "requiresLogin": true or false
}`
    }];

    // Agent loop - let Claude drive the browser
    let maxIterations = 25;
    while (maxIterations-- > 0) {
      console.log(`[UBER] Iteration ${25 - maxIterations}...`);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: claudeTools,
        messages
      });

      console.log(`[UBER] Response stop_reason: ${response.stop_reason}`);

      // Check if Claude is done (returned final text without tool use)
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(c => c.type === 'text');
        if (textBlock?.text) {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`[UBER] Quote fetched in ${Date.now() - startTime}ms`);
            console.log(`[UBER] Result: ${JSON.stringify(result)}`);

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
        console.log(`[UBER] Calling tool: ${block.name}`);
        try {
          const result = await mcpClient.callTool({ name: block.name, arguments: block.input });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.content)
          });
        } catch (err) {
          console.error(`[UBER] Tool error: ${err.message}`);
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
  confirmUberRide,
  getUberStatus,
  cancelUberRide
};
