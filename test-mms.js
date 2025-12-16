#!/usr/bin/env node
/**
 * Test script for MMS photo handling
 *
 * Usage: node test-mms.js <image-path> [text-message]
 * Example: node test-mms.js ~/Downloads/slice_of_bread.jpeg "my breakfast"
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_PORT = process.env.PORT || 4567;
const MEDIA_SERVER_PORT = 3001;

async function main() {
  const imagePath = process.argv[2];
  const textMessage = process.argv[3] || '';

  if (!imagePath) {
    console.error('Usage: node test-mms.js <image-path> [text-message]');
    console.error('Example: node test-mms.js ~/Downloads/bread.jpg "my lunch"');
    process.exit(1);
  }

  // Resolve ~ to home directory
  const resolvedPath = imagePath.replace(/^~/, process.env.HOME);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const imageBuffer = fs.readFileSync(resolvedPath);
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeType = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
  }[ext] || 'image/jpeg';

  console.log(`Testing MMS with image: ${resolvedPath}`);
  console.log(`MIME type: ${mimeType}`);
  if (textMessage) console.log(`Text message: "${textMessage}"`);
  console.log('---');

  // Start a temporary server to serve the image (simulating Twilio's media server)
  const mediaServer = http.createServer((req, res) => {
    // Ignore auth headers for local testing
    res.setHeader('Content-Type', mimeType);
    res.end(imageBuffer);
  });

  await new Promise(resolve => mediaServer.listen(MEDIA_SERVER_PORT, resolve));
  console.log(`Media server running on port ${MEDIA_SERVER_PORT}`);

  try {
    // Build the Twilio-style webhook payload
    const payload = new URLSearchParams({
      Body: textMessage,
      From: '+15551234567',
      To: '+15559876543',
      NumMedia: '1',
      MediaUrl0: `http://localhost:${MEDIA_SERVER_PORT}/image`,
      MediaContentType0: mimeType,
    });

    // POST to the local SMS endpoint
    const response = await fetch(`http://localhost:${SERVER_PORT}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });

    const responseText = await response.text();

    console.log(`\nResponse status: ${response.status}`);
    console.log('Response body (TwiML):');
    console.log(responseText);

    // Extract the message content from TwiML for easier reading
    const messageMatch = responseText.match(/<Message>([\s\S]*?)<\/Message>/);
    if (messageMatch) {
      console.log('\n--- Parsed SMS Response ---');
      console.log(messageMatch[1]);
    }

  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error(`\nError: Could not connect to server at localhost:${SERVER_PORT}`);
      console.error('Make sure your server is running: node server.js');
    } else {
      console.error('\nError:', error.message);
    }
  } finally {
    mediaServer.close();
  }
}

main();
