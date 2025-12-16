const axios = require('axios');

const MTA_BASE_URL = 'https://bustime.mta.info/api/siri/stop-monitoring.json';

class MTABusAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Get bus arrivals for a specific stop
   * @param {string} stopCode - The 6-digit MTA stop code
   * @param {string} routeFilter - Optional route filter (e.g., 'B63', 'M15')
   * @returns {Promise<Object>} Arrival information
   */
  async getStopArrivals(stopCode, routeFilter = null) {
    try {
      const params = {
        key: this.apiKey,
        OperatorRef: 'MTA',
        MonitoringRef: stopCode,
        MaximumStopVisits: 5
      };

      // Add route filter if provided
      if (routeFilter) {
        // MTA uses format: "MTA NYCT_B63"
        params.LineRef = `MTA NYCT_${routeFilter.toUpperCase()}`;
      }

      const axiosStart = Date.now();
      const response = await axios.get(MTA_BASE_URL, { params });
      console.log(`[TIMING] mta-axios-get: ${Date.now() - axiosStart}ms`);

      return this.parseResponse(response.data);
    } catch (error) {
      console.error('MTA API Error:', error.message);
      throw new Error('Unable to fetch bus times');
    }
  }

  /**
   * Parse MTA API response into simplified format
   */
  parseResponse(data) {
    const stopVisits = data?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit;

    if (!stopVisits || stopVisits.length === 0) {
      return {
        found: false,
        arrivals: []
      };
    }

    const arrivals = stopVisits.map(visit => {
      const journey = visit.MonitoredVehicleJourney;
      const call = journey.MonitoredCall;

      return {
        route: journey.PublishedLineName,
        destination: journey.DestinationName,
        stopsAway: call.Extensions?.Distances?.StopsFromCall || 0,
        distanceMeters: call.Extensions?.Distances?.DistanceFromCall || 0,
        expectedArrival: call.ExpectedArrivalTime,
        hasRealtimeData: journey.Monitored
      };
    });

    return {
      found: true,
      stopName: stopVisits[0]?.MonitoredVehicleJourney?.MonitoredCall?.StopPointName || 'Unknown Stop',
      arrivals
    };
  }

  /**
   * Format arrivals into human-readable text message
   */
  formatAsText(parsedData, maxResults = 3) {
    if (!parsedData.found || parsedData.arrivals.length === 0) {
      return 'No buses found arriving at this stop right now. Please check your stop code and try again, or visit bustime.mta.info for more info.';
    }

    // Add header to make message more conversational (avoid OTP filtering)
    let message = `Bus arrivals at ${parsedData.stopName}:\n\n`;

    parsedData.arrivals.slice(0, maxResults).forEach((arrival, index) => {
      const stopsText = arrival.stopsAway === 0
        ? 'arriving now'
        : `${arrival.stopsAway} stop${arrival.stopsAway > 1 ? 's' : ''} away`;

      message += `Route ${arrival.route} to ${arrival.destination} - ${stopsText}`;

      if (!arrival.hasRealtimeData) {
        message += ' (scheduled time)';
      }

      if (index < Math.min(maxResults, parsedData.arrivals.length) - 1) {
        message += '\n\n';
      }
    });

    // Add footer with total count if more buses available
    const totalBuses = parsedData.arrivals.length;
    if (totalBuses > maxResults) {
      message += `\n\n(Showing ${maxResults} of ${totalBuses} buses)`;
    }

    return message;
  }
}

module.exports = MTABusAPI;
