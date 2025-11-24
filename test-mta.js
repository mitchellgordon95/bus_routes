require('dotenv').config();
const MTABusAPI = require('./mta-api');

// Test the MTA API with a known stop
async function test() {
  if (!process.env.MTA_API_KEY) {
    console.error('❌ MTA_API_KEY not found in .env file');
    console.log('Get one at: https://register.developer.obanyc.com/');
    process.exit(1);
  }

  const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);

  console.log('🚌 Testing MTA Bus Time API...\n');

  // Test stop 308209 (5th Ave & Union St, Brooklyn - serves B63)
  const testStopCode = '308209';
  console.log(`Querying stop ${testStopCode}...`);

  try {
    const data = await mtaAPI.getStopArrivals(testStopCode);

    if (data.found) {
      console.log('✅ API connection successful!\n');
      console.log('Sample response:');
      console.log('================');
      console.log(mtaAPI.formatAsText(data));
      console.log('================\n');
      console.log(`Found ${data.arrivals.length} arriving buses`);
    } else {
      console.log('⚠️  API returned no results for this stop');
      console.log('This might mean:');
      console.log('  - No buses currently en route');
      console.log('  - Invalid stop code');
      console.log('  - Service disruption');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\nPossible issues:');
    console.log('  - Invalid API key');
    console.log('  - Network connectivity');
    console.log('  - MTA API downtime');
  }
}

test();
