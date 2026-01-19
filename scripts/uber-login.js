#!/usr/bin/env node
/**
 * Manual Uber Login Script
 *
 * Connects to Playwright MCP server and opens Uber login page.
 * User logs in manually (solves CAPTCHA), then cookies are exported.
 *
 * Usage:
 *   node scripts/uber-login.js
 *
 * After login, cookies are saved to:
 *   - uber-cookies.json (for reference)
 *   - Prints base64 string to set as UBER_COOKIES env var in Railway
 */

const fs = require('fs');
const path = require('path');

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
    console.log('4. Press Enter here when done to export cookies');
    console.log('========================================\n');

    // Wait for user to press Enter
    process.stdin.setRawMode?.(false);
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });

    // Export cookies using browser_run_code
    console.log('Exporting cookies...');
    const result = await client.callTool({
      name: 'browser_run_code',
      arguments: {
        code: `async ({ context }) => {
          const cookies = await context.cookies();
          return JSON.stringify(cookies);
        }`
      }
    });

    // Parse the result - it comes back as an array with text content
    let cookies = [];
    try {
      const content = result.content || result;
      const textContent = Array.isArray(content)
        ? content.find(c => c.type === 'text')?.text
        : (typeof content === 'string' ? content : JSON.stringify(content));

      // The result might have extra wrapper text, try to extract JSON array
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        cookies = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse cookies:', e.message);
      console.log('Raw result:', JSON.stringify(result, null, 2));
      process.exit(1);
    }

    if (!cookies.length) {
      console.error('No cookies found! Make sure you logged in.');
      process.exit(1);
    }

    // Filter to just Uber cookies
    const uberCookies = cookies.filter(c =>
      c.domain?.includes('uber.com')
    );

    console.log(`Found ${uberCookies.length} Uber cookies`);

    // Save to JSON file
    const cookiesPath = path.join(__dirname, '..', 'uber-cookies.json');
    fs.writeFileSync(cookiesPath, JSON.stringify(uberCookies, null, 2));
    console.log(`\nSaved to: ${cookiesPath}`);

    // Output base64 for Railway env var
    const base64 = Buffer.from(JSON.stringify(uberCookies)).toString('base64');
    console.log('\n========================================');
    console.log('  SET THIS AS UBER_COOKIES IN RAILWAY:');
    console.log('========================================');
    console.log(base64);
    console.log('========================================\n');

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
