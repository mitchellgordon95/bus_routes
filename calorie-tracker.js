const { sql } = require('@vercel/postgres');

/**
 * Initialize the calories table if it doesn't exist
 */
async function initTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS daily_calories (
      date DATE PRIMARY KEY,
      total INTEGER DEFAULT 0
    )
  `;
}

/**
 * Get today's date key (YYYY-MM-DD)
 */
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
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

  const { rows } = await sql`
    INSERT INTO daily_calories (date, total)
    VALUES (${today}, ${amount})
    ON CONFLICT (date)
    DO UPDATE SET total = daily_calories.total + ${amount}
    RETURNING total
  `;

  return rows[0].total;
}

/**
 * Get today's total calories
 * @returns {Promise<number>}
 */
async function getTodayTotal() {
  await initTable();
  const today = getTodayKey();

  const { rows } = await sql`
    SELECT total FROM daily_calories WHERE date = ${today}
  `;

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
  await sql`
    INSERT INTO daily_calories (date, total)
    VALUES (${today}, 0)
    ON CONFLICT (date)
    DO UPDATE SET total = 0
  `;

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

  const { rows } = await sql`
    INSERT INTO daily_calories (date, total)
    VALUES (${today}, 0)
    ON CONFLICT (date)
    DO UPDATE SET total = GREATEST(0, daily_calories.total - ${amount})
    RETURNING total
  `;

  return rows[0].total;
}

module.exports = { addCalories, subtractCalories, getTodayTotal, resetToday };
