const Anthropic = require('@anthropic-ai/sdk');
const { getWorkoutHistory } = require('./workout-tracker');

const anthropic = new Anthropic();
const MODEL = 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `You are a concise personal trainer sending a morning workout plan via SMS.

Equipment available: adjustable dumbbell set, a workout bench, and a pull-up bar. No barbell, no cable machine.

Rules:
- Keep it SHORT and SMS-friendly. Plain text only, no markdown.
- Only suggest exercises doable with dumbbells and a bench.
- Include specific exercises, weights, sets, and reps based on the user's recent history.
- Suggest progressive overload: slightly more weight or reps than last time where appropriate.
- Rotate muscle groups so recently worked muscles get rest.
- If a muscle group hasn't been trained in 3+ days, prioritize it.
- Format each exercise on its own line with weight, sets x reps.
- End with a brief motivating note (one short sentence max).`;

/**
 * Generate and send a morning workout plan via SMS
 * @param {Function} sendSMS - async function(to, from, body)
 * @param {string} toNumber - recipient phone number
 * @param {string} fromNumber - Twilio phone number to send from
 */
async function sendMorningWorkout(sendSMS, toNumber, fromNumber) {
  const history = await getWorkoutHistory(14);

  if (history.length === 0) {
    await sendSMS(toNumber, fromNumber,
      'Good morning! Text me your workouts (e.g. "bench 185 3x8") to get personalized daily plans.');
    console.log('[CRON] No workout history - sent nudge');
    return;
  }

  // Format history for Claude
  let historyText = 'Recent workout history:\n';
  for (const day of history) {
    historyText += `\n${day.date}:`;
    for (const ex of day.exercises) {
      let entry = ` ${ex.exercise}`;
      if (ex.weightLbs) entry += ` ${ex.weightLbs}lbs`;
      entry += ` ${ex.sets}x${ex.reps}`;
      historyText += `\n  - ${entry}`;
    }
  }

  const apiStart = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' })}. Generate today's workout plan.\n\n${historyText}`
    }]
  });
  console.log(`[CRON] Claude response: ${Date.now() - apiStart}ms`);

  const plan = response.content.find(c => c.type === 'text')?.text
    || 'Could not generate workout plan. Text "workout plan" to try manually.';

  await sendSMS(toNumber, fromNumber, plan);
  console.log('[CRON] Morning workout sent');
}

module.exports = { sendMorningWorkout };
