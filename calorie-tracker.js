const { Pool } = require('pg');

const DEFAULT_TARGET = 1800;

// Create a connection pool using DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

/**
 * Initialize the calories table if it doesn't exist
 */
async function initTable() {
  const start = Date.now();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_calories (
      date DATE PRIMARY KEY,
      total INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  console.log(`[TIMING] db-initTable: ${Date.now() - start}ms`);
}

/**
 * Get today's date key (YYYY-MM-DD) in Eastern Time
 */
function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Add calories to today's total
 * @param {number} calories - Calories to add
 * @returns {Promise<number>} New daily total
 */
async function addCalories(calories) {
  await initTable();
  const today = getTodayKey();
  const amount = Math.round(calories);

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    INSERT INTO daily_calories (date, total)
    VALUES ($1, $2)
    ON CONFLICT (date)
    DO UPDATE SET total = daily_calories.total + $2
    RETURNING total
  `, [today, amount]);
  console.log(`[TIMING] db-addCalories-query: ${Date.now() - queryStart}ms`);

  return rows[0].total;
}

/**
 * Get today's total calories
 * @returns {Promise<number>}
 */
async function getTodayTotal() {
  await initTable();
  const today = getTodayKey();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT total FROM daily_calories WHERE date = $1
  `, [today]);
  console.log(`[TIMING] db-getTodayTotal-query: ${Date.now() - queryStart}ms`);

  return rows[0]?.total || 0;
}

/**
 * Reset today's calories
 * @returns {Promise<number>} Previous total before reset
 */
async function resetToday() {
  await initTable();
  const today = getTodayKey();

  // Get current total first
  const previous = await getTodayTotal();

  // Reset to 0
  const queryStart = Date.now();
  await pool.query(`
    INSERT INTO daily_calories (date, total)
    VALUES ($1, 0)
    ON CONFLICT (date)
    DO UPDATE SET total = 0
  `, [today]);
  console.log(`[TIMING] db-resetToday-query: ${Date.now() - queryStart}ms`);

  return previous;
}

/**
 * Subtract calories from today's total
 * @param {number} calories - Calories to subtract
 * @returns {Promise<number>} New daily total
 */
async function subtractCalories(calories) {
  await initTable();
  const today = getTodayKey();
  const amount = Math.round(calories);

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    INSERT INTO daily_calories (date, total)
    VALUES ($1, 0)
    ON CONFLICT (date)
    DO UPDATE SET total = GREATEST(0, daily_calories.total - $2)
    RETURNING total
  `, [today, amount]);
  console.log(`[TIMING] db-subtractCalories-query: ${Date.now() - queryStart}ms`);

  return rows[0].total;
}

/**
 * Get the daily calorie target
 * @returns {Promise<number>}
 */
async function getTarget() {
  await initTable();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT value FROM settings WHERE key = 'calorie_target'
  `);
  console.log(`[TIMING] db-getTarget-query: ${Date.now() - queryStart}ms`);

  return rows[0] ? parseInt(rows[0].value, 10) : DEFAULT_TARGET;
}

/**
 * Set the daily calorie target
 * @param {number} target - New target
 * @returns {Promise<number>} The new target
 */
async function setTarget(target) {
  await initTable();
  const value = Math.round(target).toString();

  const queryStart = Date.now();
  await pool.query(`
    INSERT INTO settings (key, value)
    VALUES ('calorie_target', $1)
    ON CONFLICT (key)
    DO UPDATE SET value = $1
  `, [value]);
  console.log(`[TIMING] db-setTarget-query: ${Date.now() - queryStart}ms`);

  return parseInt(value, 10);
}

module.exports = { addCalories, subtractCalories, getTodayTotal, resetToday, getTarget, setTarget };
