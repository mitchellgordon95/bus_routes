/**
 * Parse incoming SMS message to extract stop code and optional route
 * Supports formats:
 * - "308209" (just stop code)
 * - "308209 B63" (stop code + route)
 * - "stop 308209" (natural language)
 * - "bus 308209 B63" (natural language with route)
 * - "check 308209" (natural language)
 */
class MessageParser {
  parse(messageBody) {
    const trimmed = messageBody.trim();

    // Check for refresh command
    if (trimmed.toUpperCase() === 'R' || trimmed.toUpperCase() === 'REFRESH') {
      return { type: 'refresh' };
    }

    // Check for service changes command (e.g., "C S79-SBS")
    if (trimmed.toUpperCase().startsWith('C ')) {
      const route = trimmed.substring(2).trim();
      return { type: 'service_changes', route };
    }

    // Extract stop code and route - support natural language
    // Patterns:
    // - "stop 308209" or "bus 308209" or "check 308209"
    // - "stop 308209 B63" (with route)
    // - "308209" (bare stop code)
    // - "308209 B63" (bare with route)
    const naturalMatch = trimmed.match(/(?:stop|bus|check|query|when|times?)?\s*(\d{6})(?:\s+([A-Z0-9\-]+))?/i);

    if (naturalMatch) {
      return {
        type: 'stop_query',
        stopCode: naturalMatch[1],
        route: naturalMatch[2] ? naturalMatch[2].toUpperCase() : null
      };
    }

    // If no stop code pattern matched, return helpful error
    return {
      type: 'error',
      message: 'Please send a bus stop code. Example: "stop 308209" or "bus 308209 B63". Find stop codes at bustime.mta.info'
    };
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
