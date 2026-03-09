const { Pool } = require('pg');

// Create a connection pool using DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

const OVERHEAD_MULTIPLIER = 1.5; // metabolic overhead (elevated HR, EPOC)

/**
 * Initialize the workout_sets table if it doesn't exist
 */
async function initTable() {
  const start = Date.now();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_sets (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      exercise TEXT NOT NULL,
      weight_lbs NUMERIC,
      reps INTEGER NOT NULL,
      calories_burned INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log(`[TIMING] workout-db-initTable: ${Date.now() - start}ms`);
}

/**
 * Get today's date key (YYYY-MM-DD) in Eastern Time
 */
function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Estimate calories burned per set
 * @param {number|null} weightLbs - Weight in pounds (null/0 for bodyweight)
 * @param {number} reps - Reps per set
 * @returns {number} Estimated calories per set
 */
function estimateCaloriesPerSet(weightLbs, reps) {
  if (!weightLbs || weightLbs === 0) return 5;
  return Math.max(5, Math.round(weightLbs * reps * 0.005));
}

/**
 * Log one or more sets of an exercise
 * @param {string} exercise - Exercise name
 * @param {number|null} weightLbs - Weight in pounds (null for bodyweight)
 * @param {number} reps - Reps per set
 * @param {number} numSets - Number of sets to log
 * @returns {Promise<Object>} Log result with calorie info
 */
async function logSets(exercise, weightLbs, reps, numSets = 1) {
  await initTable();
  const today = getTodayKey();
  const caloriesPerSet = estimateCaloriesPerSet(weightLbs, reps);

  const queryStart = Date.now();

  // Insert all sets
  const values = [];
  const placeholders = [];
  for (let i = 0; i < numSets; i++) {
    const offset = i * 5;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
    values.push(today, exercise, weightLbs || null, reps, caloriesPerSet);
  }

  await pool.query(`
    INSERT INTO workout_sets (date, exercise, weight_lbs, reps, calories_burned)
    VALUES ${placeholders.join(', ')}
  `, values);
  console.log(`[TIMING] workout-db-logSets: ${Date.now() - queryStart}ms`);

  // Get today's summary
  const todaySummary = await getTodaySets();

  return {
    exercise,
    weightLbs,
    reps,
    setsLogged: numSets,
    caloriesPerSet,
    totalCaloriesThisExercise: caloriesPerSet * numSets,
    todaySummary
  };
}

/**
 * Get total exercise calories burned today (with overhead multiplier)
 * @returns {Promise<number>} Total exercise calories
 */
async function getExerciseCaloriesToday() {
  await initTable();
  const today = getTodayKey();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(calories_burned), 0) as total
    FROM workout_sets
    WHERE date = $1
  `, [today]);
  console.log(`[TIMING] workout-db-getExerciseCals: ${Date.now() - queryStart}ms`);

  const rawTotal = parseInt(rows[0].total, 10);
  return Math.round(rawTotal * OVERHEAD_MULTIPLIER);
}

/**
 * Get today's exercises grouped by exercise name
 * @returns {Promise<Array>} Today's exercises with set details
 */
async function getTodaySets() {
  await initTable();
  const today = getTodayKey();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT exercise, weight_lbs, reps, COUNT(*) as num_sets, SUM(calories_burned) as total_cals
    FROM workout_sets
    WHERE date = $1
    GROUP BY exercise, weight_lbs, reps
    ORDER BY MIN(created_at)
  `, [today]);
  console.log(`[TIMING] workout-db-getTodaySets: ${Date.now() - queryStart}ms`);

  return rows.map(r => ({
    exercise: r.exercise,
    weightLbs: r.weight_lbs ? parseFloat(r.weight_lbs) : null,
    reps: r.reps,
    sets: parseInt(r.num_sets, 10),
    calories: parseInt(r.total_cals, 10)
  }));
}

/**
 * Get workout history for the last N days
 * @param {number} days - Number of days to look back
 * @returns {Promise<Array>} Workout history grouped by date and exercise
 */
async function getWorkoutHistory(days = 14) {
  await initTable();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT date, exercise, weight_lbs, reps, COUNT(*) as num_sets
    FROM workout_sets
    WHERE date >= CURRENT_DATE - $1::INTEGER
    GROUP BY date, exercise, weight_lbs, reps
    ORDER BY date DESC, MIN(created_at)
  `, [days]);
  console.log(`[TIMING] workout-db-getHistory: ${Date.now() - queryStart}ms`);

  // Group by date
  const byDate = {};
  for (const row of rows) {
    const dateStr = row.date.toISOString().split('T')[0];
    if (!byDate[dateStr]) {
      byDate[dateStr] = [];
    }
    byDate[dateStr].push({
      exercise: row.exercise,
      weightLbs: row.weight_lbs ? parseFloat(row.weight_lbs) : null,
      reps: row.reps,
      sets: parseInt(row.num_sets, 10)
    });
  }

  return Object.entries(byDate).map(([date, exercises]) => ({
    date,
    exercises
  }));
}

/**
 * Update an exercise logged today (delete old rows, insert new ones)
 */
async function updateExercise(exercise, oldWeightLbs, oldReps, newWeightLbs, newReps, newSets) {
  await initTable();
  const today = getTodayKey();

  const queryStart = Date.now();

  // Delete existing rows matching exercise + old weight + old reps
  const deleteParams = [today, exercise.toLowerCase()];
  let deleteWhere = 'date = $1 AND LOWER(exercise) = $2';
  if (oldWeightLbs != null) {
    deleteParams.push(oldWeightLbs);
    deleteWhere += ` AND weight_lbs = $${deleteParams.length}`;
  } else {
    deleteWhere += ' AND weight_lbs IS NULL';
  }
  if (oldReps != null) {
    deleteParams.push(oldReps);
    deleteWhere += ` AND reps = $${deleteParams.length}`;
  }

  const { rowCount } = await pool.query(`DELETE FROM workout_sets WHERE ${deleteWhere}`, deleteParams);

  if (rowCount === 0) {
    console.log(`[TIMING] workout-db-updateExercise: ${Date.now() - queryStart}ms (no match)`);
    return { found: false };
  }

  // Insert new rows
  const caloriesPerSet = estimateCaloriesPerSet(newWeightLbs, newReps);
  const values = [];
  const placeholders = [];
  for (let i = 0; i < newSets; i++) {
    const offset = i * 5;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
    values.push(today, exercise, newWeightLbs || null, newReps, caloriesPerSet);
  }

  await pool.query(`
    INSERT INTO workout_sets (date, exercise, weight_lbs, reps, calories_burned)
    VALUES ${placeholders.join(', ')}
  `, values);
  console.log(`[TIMING] workout-db-updateExercise: ${Date.now() - queryStart}ms`);

  const todaySummary = await getTodaySets();
  return { found: true, deletedSets: rowCount, newSets, todaySummary };
}

/**
 * Delete an exercise logged today
 */
async function deleteExercise(exercise, weightLbs, reps) {
  await initTable();
  const today = getTodayKey();

  const queryStart = Date.now();
  const params = [today, exercise.toLowerCase()];
  let where = 'date = $1 AND LOWER(exercise) = $2';

  if (weightLbs != null) {
    params.push(weightLbs);
    where += ` AND weight_lbs = $${params.length}`;
  }
  if (reps != null) {
    params.push(reps);
    where += ` AND reps = $${params.length}`;
  }

  const { rowCount } = await pool.query(`DELETE FROM workout_sets WHERE ${where}`, params);
  console.log(`[TIMING] workout-db-deleteExercise: ${Date.now() - queryStart}ms`);

  const todaySummary = await getTodaySets();
  return { deletedSets: rowCount, todaySummary };
}

/**
 * Reset all workout history
 */
async function resetWorkoutHistory() {
  await initTable();
  const queryStart = Date.now();
  const { rowCount } = await pool.query('DELETE FROM workout_sets');
  console.log(`[TIMING] workout-db-resetHistory: ${Date.now() - queryStart}ms`);
  return { deletedSets: rowCount };
}

module.exports = {
  logSets,
  getExerciseCaloriesToday,
  getTodaySets,
  getWorkoutHistory,
  updateExercise,
  deleteExercise,
  resetWorkoutHistory
};
