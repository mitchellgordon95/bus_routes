const { sql } = require('@vercel/postgres');

const EXPIRY_MINUTES = 10;

/**
 * Initialize the pending uber rides table if it doesn't exist
 */
async function initTable() {
  const start = Date.now();
  await sql`
    CREATE TABLE IF NOT EXISTS pending_uber_rides (
      phone VARCHAR(20) PRIMARY KEY,
      pickup_address TEXT NOT NULL,
      destination_address TEXT NOT NULL,
      pickup_lat DECIMAL(10, 7) NOT NULL,
      pickup_lng DECIMAL(10, 7) NOT NULL,
      dest_lat DECIMAL(10, 7) NOT NULL,
      dest_lng DECIMAL(10, 7) NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price_estimate TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  // Also create table for active rides
  await sql`
    CREATE TABLE IF NOT EXISTS active_uber_rides (
      phone VARCHAR(20) PRIMARY KEY,
      request_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  console.log(`[TIMING] uber-db-initTable: ${Date.now() - start}ms`);
}

/**
 * Save a pending ride quote for later confirmation
 * @param {string} phone - User's phone number
 * @param {Object} quote - Quote from UberAPI.getQuote()
 */
async function savePendingRide(phone, quote) {
  await initTable();

  const queryStart = Date.now();
  await sql`
    INSERT INTO pending_uber_rides (
      phone, pickup_address, destination_address,
      pickup_lat, pickup_lng, dest_lat, dest_lng,
      product_id, product_name, price_estimate
    )
    VALUES (
      ${phone}, ${quote.pickup.address}, ${quote.destination.address},
      ${quote.pickup.lat}, ${quote.pickup.lng},
      ${quote.destination.lat}, ${quote.destination.lng},
      ${quote.productId}, ${quote.productName}, ${quote.priceEstimate}
    )
    ON CONFLICT (phone)
    DO UPDATE SET
      pickup_address = ${quote.pickup.address},
      destination_address = ${quote.destination.address},
      pickup_lat = ${quote.pickup.lat},
      pickup_lng = ${quote.pickup.lng},
      dest_lat = ${quote.destination.lat},
      dest_lng = ${quote.destination.lng},
      product_id = ${quote.productId},
      product_name = ${quote.productName},
      price_estimate = ${quote.priceEstimate},
      created_at = NOW()
  `;
  console.log(`[TIMING] uber-db-savePending: ${Date.now() - queryStart}ms`);
}

/**
 * Get a pending ride for a phone number
 * @param {string} phone - User's phone number
 * @returns {Promise<Object|null>} Pending ride or null if expired/not found
 */
async function getPendingRide(phone) {
  await initTable();

  const queryStart = Date.now();
  const { rows } = await sql`
    SELECT * FROM pending_uber_rides
    WHERE phone = ${phone}
    AND created_at > NOW() - INTERVAL '10 minutes'
  `;
  console.log(`[TIMING] uber-db-getPending: ${Date.now() - queryStart}ms`);

  if (!rows[0]) return null;

  const row = rows[0];
  return {
    pickup: {
      address: row.pickup_address,
      lat: parseFloat(row.pickup_lat),
      lng: parseFloat(row.pickup_lng)
    },
    destination: {
      address: row.destination_address,
      lat: parseFloat(row.dest_lat),
      lng: parseFloat(row.dest_lng)
    },
    productId: row.product_id,
    productName: row.product_name,
    priceEstimate: row.price_estimate
  };
}

/**
 * Clear a pending ride after booking or cancellation
 * @param {string} phone - User's phone number
 */
async function clearPendingRide(phone) {
  await initTable();

  const queryStart = Date.now();
  await sql`DELETE FROM pending_uber_rides WHERE phone = ${phone}`;
  console.log(`[TIMING] uber-db-clearPending: ${Date.now() - queryStart}ms`);
}

/**
 * Save an active ride request ID
 * @param {string} phone - User's phone number
 * @param {string} requestId - Uber ride request ID
 */
async function saveActiveRide(phone, requestId) {
  await initTable();

  const queryStart = Date.now();
  await sql`
    INSERT INTO active_uber_rides (phone, request_id)
    VALUES (${phone}, ${requestId})
    ON CONFLICT (phone)
    DO UPDATE SET request_id = ${requestId}, created_at = NOW()
  `;
  console.log(`[TIMING] uber-db-saveActive: ${Date.now() - queryStart}ms`);
}

/**
 * Get active ride request ID for a phone number
 * @param {string} phone - User's phone number
 * @returns {Promise<string|null>} Request ID or null
 */
async function getActiveRide(phone) {
  await initTable();

  const queryStart = Date.now();
  const { rows } = await sql`
    SELECT request_id FROM active_uber_rides WHERE phone = ${phone}
  `;
  console.log(`[TIMING] uber-db-getActive: ${Date.now() - queryStart}ms`);

  return rows[0]?.request_id || null;
}

/**
 * Clear an active ride
 * @param {string} phone - User's phone number
 */
async function clearActiveRide(phone) {
  await initTable();

  const queryStart = Date.now();
  await sql`DELETE FROM active_uber_rides WHERE phone = ${phone}`;
  console.log(`[TIMING] uber-db-clearActive: ${Date.now() - queryStart}ms`);
}

/**
 * Cleanup expired pending rides (called opportunistically)
 */
async function cleanupExpiredRides() {
  await initTable();

  const queryStart = Date.now();
  const result = await sql`
    DELETE FROM pending_uber_rides
    WHERE created_at < NOW() - INTERVAL '10 minutes'
  `;
  console.log(`[TIMING] uber-db-cleanup: ${Date.now() - queryStart}ms (${result.rowCount || 0} removed)`);
}

module.exports = {
  savePendingRide,
  getPendingRide,
  clearPendingRide,
  saveActiveRide,
  getActiveRide,
  clearActiveRide,
  cleanupExpiredRides
};
