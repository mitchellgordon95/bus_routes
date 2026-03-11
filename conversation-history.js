const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function initTable() {
  const start = Date.now();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log(`[TIMING] convo-db-initTable: ${Date.now() - start}ms`);
}

/**
 * Save a conversation message
 * @param {string} phone - Phone number
 * @param {string} role - 'user' or 'assistant'
 * @param {string|Array} content - Message content (text string or content blocks array)
 */
async function saveMessage(phone, role, content) {
  await initTable();

  // Extract text only (strip base64 images)
  let textContent;
  if (Array.isArray(content)) {
    const hasImage = content.some(c => c.type === 'image');
    const textPart = content.find(c => c.type === 'text')?.text || '';
    textContent = hasImage ? `[sent a photo] ${textPart}` : textPart;
  } else {
    textContent = typeof content === 'string' ? content : JSON.stringify(content);
  }

  const queryStart = Date.now();
  await pool.query(
    'INSERT INTO conversation_history (phone, role, content) VALUES ($1, $2, $3)',
    [phone, role, textContent]
  );
  console.log(`[TIMING] convo-db-saveMessage: ${Date.now() - queryStart}ms`);

  // Opportunistic cleanup of old messages
  pool.query("DELETE FROM conversation_history WHERE created_at < NOW() - INTERVAL '24 hours'")
    .catch(err => console.error('[CONVO] Cleanup error:', err.message));
}

/**
 * Get recent conversation messages for a phone number
 * @param {string} phone - Phone number
 * @returns {Promise<Array<{role: string, content: string}>>} Messages in chronological order
 */
async function getRecentMessages(phone) {
  await initTable();

  const queryStart = Date.now();
  const { rows } = await pool.query(`
    SELECT role, content FROM conversation_history
    WHERE phone = $1 AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `, [phone]);
  console.log(`[TIMING] convo-db-getRecent: ${Date.now() - queryStart}ms (${rows.length} messages)`);

  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content
  }));
}

module.exports = { saveMessage, getRecentMessages };
