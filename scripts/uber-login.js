#!/usr/bin/env node
/**
 * Manual Uber Login Script
 *
 * Connects to Playwright MCP server and opens Uber login page.
 * User logs in manually (solves CAPTCHA), cookies auto-save to user-data-dir.
 *
 * Usage:
 *   Local:  node scripts/uber-login.js
 *   Prod:   PLAYWRIGHT_MCP_URL=http://playwright-mcp.railway.internal:3666 node scripts/uber-login.js
 */

const MCP_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://localhost:3666';

async function main() {
  console.log(`Connecting to Playwright MCP at ${MCP_URL}...`);

  // Load MCP SDK (ESM)
  const { Client } = await import('@modelcontextprotocol/sdk/client');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const transport = new StreamableHTTPClientTransport(new URL('/mcp', MCP_URL));
  const client = new Client({ name: 'uber-login', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('Connected to Playwright MCP server\n');

    // Navigate to Uber
    console.log('Opening Uber...');
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://m.uber.com' }
    });

    console.log('\n========================================');
    console.log('  MANUAL LOGIN REQUIRED');
    console.log('========================================');
    console.log('1. Log into Uber in the browser window');
    console.log('2. Solve any CAPTCHA challenges');
    console.log('3. Navigate around to confirm you\'re logged in');
    console.log('4. Press Enter here when done to save session');
    console.log('========================================\n');

    // Wait for user to press Enter
    process.stdin.setRawMode?.(false);
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });

    // Take snapshot to verify login state
    console.log('Taking snapshot to verify state...');
    const result = await client.callTool({
      name: 'browser_snapshot',
      arguments: {}
    });

    // Check if we can see logged-in indicators
    const snapshot = JSON.stringify(result);
    if (snapshot.includes('Account') || snapshot.includes('Activity') || snapshot.includes('rider')) {
      console.log('\nLogin appears successful! Session saved to browser profile.');
    } else {
      console.log('\nSnapshot captured. Session saved (verify login state in browser).');
    }

    console.log('You can now close this script. Future requests will use the saved session.');

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
