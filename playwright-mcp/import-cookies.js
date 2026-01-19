#!/usr/bin/env node
/**
 * Import Cookies Script
 *
 * Imports cookies from UBER_COOKIES env var (base64 encoded JSON) into the browser.
 * Run this after Playwright MCP server starts but before making requests.
 *
 * This script connects to the running MCP server and adds cookies to the context.
 */

const MCP_URL = process.env.PLAYWRIGHT_MCP_URL || `http://localhost:${process.env.PORT || 3666}`;
const UBER_COOKIES = process.env.UBER_COOKIES;

async function main() {
  if (!UBER_COOKIES) {
    console.log('[import-cookies] No UBER_COOKIES env var set, skipping import');
    return;
  }

  console.log('[import-cookies] Found UBER_COOKIES, importing...');

  // Decode cookies from base64
  let cookies;
  try {
    const json = Buffer.from(UBER_COOKIES, 'base64').toString('utf-8');
    cookies = JSON.parse(json);
    console.log(`[import-cookies] Decoded ${cookies.length} cookies`);
  } catch (e) {
    console.error('[import-cookies] Failed to decode UBER_COOKIES:', e.message);
    return;
  }

  // Wait a bit for MCP server to be ready
  await new Promise(r => setTimeout(r, 3000));

  // Load MCP SDK (ESM)
  const { Client } = await import('@modelcontextprotocol/sdk/client');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const transport = new StreamableHTTPClientTransport(new URL('/mcp', MCP_URL));
  const client = new Client({ name: 'cookie-importer', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('[import-cookies] Connected to MCP server');

    // Import cookies using browser_run_code
    const cookiesJson = JSON.stringify(cookies);
    const result = await client.callTool({
      name: 'browser_run_code',
      arguments: {
        code: `async ({ context }) => {
          const cookies = ${cookiesJson};
          await context.addCookies(cookies);
          return 'Added ' + cookies.length + ' cookies';
        }`
      }
    });

    console.log('[import-cookies] Result:', JSON.stringify(result.content || result));
    console.log('[import-cookies] Cookies imported successfully!');

  } catch (e) {
    console.error('[import-cookies] Failed to import cookies:', e.message);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
