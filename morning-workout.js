const { getWorkoutHistory, savePlan } = require('./workout-tracker');

// Lazy-loaded SDK imports (ESM package, loaded via dynamic import)
let _sdk = null;
async function getSDK() {
  if (!_sdk) {
    _sdk = await import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdk;
}

const SYSTEM_PROMPT = `You are a concise personal trainer sending a morning workout plan via SMS.

Rules:
- Keep it SHORT and SMS-friendly. Plain text only, no markdown.
- Include specific exercises, weights, sets, and reps based on the user's recent history.
- Suggest progressive overload: slightly more weight or reps than last time where appropriate.
- If the user rated a set "easy", increase weight next time. If "hard", hold or reduce.
- Rotate muscle groups so recently worked muscles get rest.
- If a muscle group hasn't been trained in 3+ days, prioritize it.
- Format each exercise on its own line with weight, sets x reps.
- End with a brief motivating note (one short sentence max).
- After generating the plan, ALWAYS call save_workout_plan to save it.`;

/**
 * Format workout history for the prompt
 */
function formatHistory(history) {
  if (history.length === 0) {
    return 'No recent workout history available. Generate a well-rounded full body workout with moderate weights.';
  }
  let text = 'Recent workout history:\n';
  for (const day of history) {
    text += `\n${day.date}:`;
    for (const ex of day.exercises) {
      let entry = ` ${ex.exercise}`;
      if (ex.weightLbs) entry += ` ${ex.weightLbs}lbs`;
      entry += ` ${ex.sets}x${ex.reps}`;
      if (ex.difficulty) entry += ` (${ex.difficulty})`;
      text += `\n  - ${entry}`;
    }
  }
  return text;
}

/**
 * Generate and send a morning workout plan via SMS
 * @param {Function} sendSMS - async function(to, from, body)
 * @param {string} toNumber - recipient phone number
 * @param {string} fromNumber - Twilio phone number to send from
 */
async function sendMorningWorkout(sendSMS, toNumber, fromNumber) {
  const sdk = await getSDK();
  const z = require('zod');

  const history = await getWorkoutHistory(14);
  const historyText = formatHistory(history);

  const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });

  const toolServer = sdk.createSdkMcpServer({
    name: 'workout-tools',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'save_workout_plan',
        'Save today\'s workout plan. Call this after generating the plan.',
        { plan_text: z.string().describe('The full workout plan text to save') },
        async (args) => {
          await savePlan(args.plan_text);
          return { content: [{ type: 'text', text: 'Plan saved.' }] };
        }
      )
    ]
  });

  const apiStart = Date.now();

  let plan = '';
  try {
    for await (const msg of sdk.query({
      prompt: `Today is ${dayOfWeek}. Generate today's workout plan.\n\n${historyText}`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { 'workout-tools': toolServer },
        allowedTools: ['mcp__workout-tools__save_workout_plan'],
        settingSources: ['project'],
        maxTurns: 3,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5-20250929'
      }
    })) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        plan = msg.result;
      }
    }
  } catch (err) {
    console.error(`[CRON] SDK error: ${err.message}`);
  }

  console.log(`[CRON] Claude response: ${Date.now() - apiStart}ms`);

  plan = plan || 'Could not generate workout plan. Text "workout plan" to try manually.';

  await sendSMS(toNumber, fromNumber, plan);
  console.log('[CRON] Morning workout saved and sent');
}

module.exports = { sendMorningWorkout };
