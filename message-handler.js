/**
 * Parse incoming SMS message to extract stop code and optional route
 * Supports formats:
 * - "308209" (just stop code)
 * - "308209 B63" (stop code + route)
 * - "Port Richmond Av and Orange Av S59" (intersection + route)
 */
class MessageParser {
  parse(messageBody) {
    const trimmed = messageBody.trim();

    // Check for refresh command
    if (trimmed.toUpperCase() === 'R') {
      return { type: 'refresh' };
    }

    // Check for service changes command (e.g., "C S79-SBS")
    if (trimmed.toUpperCase().startsWith('C ')) {
      const route = trimmed.substring(2).trim();
      return { type: 'service_changes', route };
    }

    // Extract stop code and route
    // Pattern: 6-digit number optionally followed by route
    const stopCodeMatch = trimmed.match(/^(\d{6})(?:\s+([A-Z0-9\-]+))?$/i);

    if (stopCodeMatch) {
      return {
        type: 'stop_query',
        stopCode: stopCodeMatch[1],
        route: stopCodeMatch[2] ? stopCodeMatch[2].toUpperCase() : null
      };
    }

    // If no stop code pattern matched, try to parse as intersection
    // This is more complex - for now, return error
    return {
      type: 'error',
      message: 'Invalid format. Text a 6-digit stop code (e.g., "308209" or "308209 B63")'
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
