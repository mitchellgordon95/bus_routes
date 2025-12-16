/**
 * Parse incoming SMS message and route to appropriate handler
 * All command routing is centralized here.
 */
class MessageParser {
  /**
   * Parse message and determine command type
   * @param {string} messageBody - The SMS message text
   * @param {boolean} hasMedia - Whether the message has media attached
   * @param {string} mediaType - MIME type of attached media (if any)
   * @returns {Object} Parsed command with type and relevant data
   */
  parse(messageBody, hasMedia = false, mediaType = null) {
    const trimmed = messageBody.trim();
    const lower = trimmed.toLowerCase();

    // Help command ("help" is reserved by Twilio, so we use "how")
    if (lower === 'how' || lower === '?') {
      return { type: 'help' };
    }

    // Calorie reset
    if (lower === 'reset calories') {
      return { type: 'reset_calories' };
    }

    // Daily total
    if (lower === 'total') {
      return { type: 'total' };
    }

    // Subtract calories (e.g., "sub 20")
    const subMatch = lower.match(/^sub\s+(\d+)$/);
    if (subMatch) {
      return { type: 'subtract', amount: parseInt(subMatch[1], 10) };
    }

    // MMS with image - process as calorie estimation
    if (hasMedia && mediaType?.startsWith('image/')) {
      return { type: 'image_calorie', textContext: trimmed };
    }

    // Refresh command
    if (lower === 'r' || lower === 'refresh') {
      return { type: 'refresh' };
    }

    // Service changes (C <route>)
    if (lower.startsWith('c ')) {
      return { type: 'service_changes', route: trimmed.substring(2).trim().toUpperCase() };
    }

    // Bus stop query (6-digit code with optional route)
    const stopMatch = trimmed.match(/(?:stop|bus|check|query|when|times?)?\s*(\d{6})(?:\s+([A-Z0-9\-]+))?/i);
    if (stopMatch) {
      return {
        type: 'stop_query',
        stopCode: stopMatch[1],
        route: stopMatch[2]?.toUpperCase() || null
      };
    }

    // Food query (fallback for text >= 2 chars)
    if (trimmed.length >= 2) {
      return { type: 'food_query', foodDescription: trimmed };
    }

    // Error fallback
    return { type: 'error', message: 'Send "how" for available commands.' };
  }

  /**
   * Get help text describing all available commands
   * @returns {string} Help message
   */
  getHelpText() {
    return `Bus Times:
• Send 6-digit stop code (e.g., 308209)
• Add route to filter (e.g., 308209 B63)

Calorie Tracking:
• Send food description (e.g., "2 eggs and toast")
• Send photo of food for estimation
• "total" - see today's calories
• "sub 50" - subtract 50 calories
• "reset calories" - start fresh

Other:
• "how" - show this message`;
  }
}

/**
 * Session manager to handle "R" refresh commands
 * Stores the last query per phone number
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.timeout = 20 * 60 * 1000; // 20 minutes
  }

  saveQuery(phoneNumber, stopCode, route) {
    this.sessions.set(phoneNumber, {
      stopCode,
      route,
      timestamp: Date.now()
    });
  }

  getLastQuery(phoneNumber) {
    const session = this.sessions.get(phoneNumber);

    if (!session) {
      return null;
    }

    // Check if session expired (20 minutes)
    if (Date.now() - session.timestamp > this.timeout) {
      this.sessions.delete(phoneNumber);
      return null;
    }

    return {
      stopCode: session.stopCode,
      route: session.route
    };
  }

  clear(phoneNumber) {
    this.sessions.delete(phoneNumber);
  }
}

module.exports = { MessageParser, SessionManager };
