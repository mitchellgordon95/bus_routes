// Import existing backends (used inside tool handlers)
const MTABusAPI = require('./mta-api');
const GeminiCalorieAPI = require('./gemini-api');
const { addCalories, subtractCalories, getTodayTotal, resetToday, getTarget, setTarget } = require('./calorie-tracker');
const { logSets, getExerciseCaloriesToday, getWorkoutHistory, updateExercise, deleteExercise, resetWorkoutHistory, savePlan, getPlan } = require('./workout-tracker');
const { saveMessage, getRecentMessages } = require('./conversation-history');

// Lazy-loaded SDK imports (ESM package, loaded via dynamic import)
let _sdk = null;
async function getSDK() {
  if (!_sdk) {
    _sdk = await import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdk;
}

// --- SYSTEM PROMPT ---
// Routing instructions for the agent. Workout planning knowledge is in .claude/skills/workout-planning/SKILL.md
const SYSTEM_PROMPT = `You are TextPal, a personal SMS assistant. You help users via text message with:
1. NYC bus arrival times
2. Calorie tracking
3. General questions
4. Workout tracking & planning

HOW TO RECOGNIZE REQUESTS:

Bus Stops:
- A 6-digit number (e.g., "308209") is an MTA bus stop code. Call lookup_bus_arrivals.
- May include a route filter after the code: "308209 B63"
- May have prefixes like "bus 308209", "stop 308209", "check 308209"

Food & Calorie Tracking:
- Text descriptions of food eaten (e.g., "2 eggs and toast", "grande latte", "chicken parm with pasta") should be logged. Call estimate_calories.
- "total" -> Call get_calorie_status to show today's total
- "sub 50" or "subtract 50" -> Call update_calories with action "subtract" and amount 50
- "reset calories" -> Call update_calories with action "reset"
- "target 2000" -> Call update_calories with action "set_target" and amount 2000
- "suggest 300" or "suggest 300 sweet" -> Call get_food_suggestions
- When someone texts food, assume they ate it and want it logged unless they clearly say otherwise.

Workout Tracking:
- Exercise descriptions like "bench 45 3x8", "squat 55 5x5", "pull-ups 3x10" → Call log_exercise
- Natural language like "did 3 sets of 8 on bench at 45" → Call log_exercise
- Parse the exercise name, weight, reps, and sets from whatever format the user provides
- Users may log one set at a time. Each log accumulates with previous sets of the same exercise today.
- Users may rate difficulty: easy (progress next time), medium (on track), hard (hold or reduce). Include in log_exercise if mentioned.
- After logging a set, call manage_workout with action "get_plan" to check today's plan. Compare what's been done so far (sets logged today) to the plan. If the user still has remaining sets of the same exercise, tell them to do another set of that exercise first. Only suggest the next exercise once all planned sets for the current one are done. If the user finishes the workout early (skips remaining exercises), that's fine — do NOT pressure them to complete the full plan.
- Bodyweight exercises (push-ups, pull-ups, dips) have no weight
- Available dumbbell weights: 15, 25, 35, 45, 55 lbs only. Always suggest these exact weights.
- "workout plan", "what should I do today", "gym plan" → Call get_workout_history, then generate a plan based on the data. After generating the plan, ALWAYS call save_workout_plan with the full plan text.
- "workout summary" or "what did I do this week" → Call get_workout_history and summarize
- "today's plan", "show my plan", "what's my plan" → Call manage_workout with action "get_plan"
- "actually did bench at 190" or "change bench to 190 3x8" → Call manage_workout with action "edit"
- "delete bench" or "remove squats" → Call manage_workout with action "delete"
- "reset workout history" → Call manage_workout with action "reset"

When generating workout plans:
- Only generate a plan for TODAY. Do not give multi-day plans unless the user explicitly asks for one.
- Look at recent history to determine which muscle groups need work
- Use difficulty ratings from history to guide progression
- Suggest progressive overload (slightly more weight or reps than last time)
- Include specific exercises, weights, sets, and reps based on the user's previous performance
- If no history exists, ask about experience level and goals to create a starter plan

General Questions:
- For anything that doesn't match the above, respond conversationally without calling any tools.
- You can answer general knowledge questions, give advice, chat, etc.

RESPONSE RULES:
- Keep responses SHORT and SMS-friendly. Plain text only, no markdown.
- Use line breaks to separate sections.
- When the user texts "how" or "?", list the available commands:

Bus Times: Send 6-digit stop code (e.g., 308209). Add route to filter (e.g., 308209 B63).
Calories: Send food description or photo. "total" for daily count. "sub 50" to subtract. "target 2000" to set goal. "suggest 300" for ideas. "reset calories" to start over.
Workout: "bench 185 3x8" to log. "change bench to 190 3x8" to edit. "delete bench" to remove. "workout plan" for today's plan. "workout summary" for history. "reset workout history" to clear all.
Uber: "uber [pickup] to [dest]" for quote. "uber confirm 1" to book. "uber status" / "uber cancel".`;

/**
 * Build the system prompt with conversation history injected
 */
function buildSystemPrompt(conversationHistory) {
  let prompt = SYSTEM_PROMPT;
  if (conversationHistory.length > 0) {
    prompt += '\n\nRecent conversation:\n';
    for (const msg of conversationHistory) {
      prompt += `${msg.role === 'user' ? 'User' : 'You'}: ${msg.content}\n`;
    }
  }
  return prompt;
}

/**
 * Create an MCP tool server with request context captured in closures
 */
function createToolServer(sdk, ctx) {
  const { tool, createSdkMcpServer } = sdk;
  const z = require('zod');

  return createSdkMcpServer({
    name: 'textpal-tools',
    version: '1.0.0',
    tools: [
      tool(
        'lookup_bus_arrivals',
        'Look up real-time bus arrivals at an MTA bus stop. Use when the user provides a 6-digit stop code.',
        { stop_code: z.string().describe('6-digit MTA bus stop code'), route: z.string().optional().describe('Optional bus route filter (e.g., B63, M15)') },
        async (args) => {
          const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
          const data = await mtaAPI.getStopArrivals(args.stop_code, args.route || null);
          return { content: [{ type: 'text', text: mtaAPI.formatAsText(data) }] };
        }
      ),

      tool(
        'estimate_calories',
        'Estimate calories for a food description, log them, and return the daily total. Use when the user describes food in text.',
        { food_description: z.string().describe('Natural language food description (e.g., "2 eggs and toast")') },
        async (args) => {
          const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
          const calorieData = await geminiAPI.estimateCalories(args.food_description);
          let text = geminiAPI.formatAsText(calorieData);
          if (calorieData.success && calorieData.totalCalories) {
            const [dailyTotal, baseTarget, exerciseCals] = await Promise.all([
              addCalories(calorieData.totalCalories), getTarget(), getExerciseCaloriesToday()
            ]);
            const adjustedTarget = baseTarget + exerciseCals;
            text += exerciseCals > 0
              ? `\n\nDaily total: ${dailyTotal} / ${adjustedTarget} cal (${baseTarget} + ${exerciseCals} exercise)`
              : `\n\nDaily total: ${dailyTotal} / ${baseTarget} cal`;
          }
          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'get_calorie_status',
        'Get today\'s calorie total and daily target. Use when user texts "total".',
        {},
        async () => {
          const [total, baseTarget, exerciseCals] = await Promise.all([
            getTodayTotal(), getTarget(), getExerciseCaloriesToday()
          ]);
          const adjustedTarget = baseTarget + exerciseCals;
          const text = exerciseCals > 0
            ? `Today's total: ${total} / ${adjustedTarget} cal (${baseTarget} + ${exerciseCals} exercise)`
            : `Today's total: ${total} / ${baseTarget} cal`;
          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'update_calories',
        'Modify calorie tracking: subtract calories, reset daily count, or set daily target.',
        {
          action: z.enum(['subtract', 'reset', 'set_target']).describe('The action to perform'),
          amount: z.number().optional().describe('Calorie amount (required for subtract and set_target)')
        },
        async (args) => {
          switch (args.action) {
            case 'subtract': {
              const [newTotal, baseTarget, exerciseCals] = await Promise.all([
                subtractCalories(args.amount), getTarget(), getExerciseCaloriesToday()
              ]);
              const adjustedTarget = baseTarget + exerciseCals;
              const display = exerciseCals > 0
                ? `${newTotal} / ${adjustedTarget} cal (${baseTarget} + ${exerciseCals} exercise)`
                : `${newTotal} / ${baseTarget} cal`;
              return { content: [{ type: 'text', text: `Subtracted ${args.amount} cal.\n\nDaily total: ${display}` }] };
            }
            case 'reset': {
              const previous = await resetToday();
              return { content: [{ type: 'text', text: `Daily calories reset. Previous total was ${previous} cal.` }] };
            }
            case 'set_target': {
              const newTarget = await setTarget(args.amount);
              return { content: [{ type: 'text', text: `Daily target set to ${newTarget} cal.` }] };
            }
            default:
              return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
          }
        }
      ),

      tool(
        'get_food_suggestions',
        'Get food suggestions for a calorie budget. Use when user texts "suggest 300" or "suggest 300 sweet".',
        {
          calories: z.number().describe('Target calories per suggestion'),
          descriptors: z.string().optional().describe('Optional descriptors like "sweet", "savory", "healthy"')
        },
        async (args) => {
          const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
          const text = await geminiAPI.getSuggestions(args.calories, args.descriptors || null);
          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'log_exercise',
        'Log weight lifting sets. Use when the user reports exercises they did.',
        {
          exercise: z.string().describe('Exercise name (e.g., "bench press", "squat", "pull-ups")'),
          weight_lbs: z.number().optional().describe('Weight in pounds. Omit or 0 for bodyweight exercises.'),
          reps: z.number().describe('Reps per set'),
          sets: z.number().optional().describe('Number of sets (default 1). Users often log one set at a time.'),
          difficulty: z.enum(['easy', 'medium', 'hard']).optional().describe('How difficult the set felt. Optional.')
        },
        async (args) => {
          const result = await logSets(
            args.exercise,
            args.weight_lbs || null,
            args.reps,
            args.sets || 1,
            args.difficulty || null
          );

          const [baseTarget, exerciseCals] = await Promise.all([
            getTarget(), getExerciseCaloriesToday()
          ]);
          const adjustedTarget = baseTarget + exerciseCals;

          let text = `Logged: ${result.exercise}`;
          if (result.weightLbs) text += ` ${result.weightLbs} lbs`;
          text += ` - ${result.setsLogged} set${result.setsLogged > 1 ? 's' : ''} of ${result.reps}`;
          if (args.difficulty) text += ` (${args.difficulty})`;
          text += ` (~${result.totalCaloriesThisExercise} cal)`;

          if (result.todaySummary.length > 0) {
            text += '\n\nToday: ';
            text += result.todaySummary.map(s => {
              let entry = s.exercise;
              if (s.weightLbs) entry += ` ${s.weightLbs}`;
              entry += ` ${s.sets}x${s.reps}`;
              if (s.difficulty) entry += ` ${s.difficulty}`;
              return entry;
            }).join(', ');
          }

          text += `\nExercise calories: ~${exerciseCals} cal`;
          text += `\nCalorie budget: ${adjustedTarget} (${baseTarget} + ${exerciseCals} exercise)`;

          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'get_workout_history',
        'Get recent workout history. Use this to generate workout plans or show exercise summaries.',
        { days: z.number().optional().describe('Number of days of history to fetch (default 14)') },
        async (args) => {
          const history = await getWorkoutHistory(args.days || 14);
          if (history.length === 0) {
            return { content: [{ type: 'text', text: 'No workout history found. Start logging exercises to build your history!' }] };
          }
          let text = 'Recent workouts:\n';
          for (const day of history) {
            text += `\n${day.date}:`;
            for (const ex of day.exercises) {
              let entry = ` ${ex.exercise}`;
              if (ex.weightLbs) entry += ` ${ex.weightLbs}lbs`;
              entry += ` ${ex.sets}x${ex.reps}`;
              if (ex.difficulty) entry += ` (${ex.difficulty})`;
              text += `\n  -${entry}`;
            }
          }
          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'save_workout_plan',
        'Save today\'s workout plan. Call this after generating a workout plan for the user.',
        { plan_text: z.string().describe('The full workout plan text to save') },
        async (args) => {
          await savePlan(args.plan_text);
          return { content: [{ type: 'text', text: 'Plan saved.' }] };
        }
      ),

      tool(
        'manage_workout',
        'Edit, delete, or reset workout entries, or retrieve today\'s plan.',
        {
          action: z.enum(['edit', 'delete', 'reset', 'get_plan']).describe('The action to perform'),
          exercise: z.string().optional().describe('Exercise name to edit/delete'),
          old_weight_lbs: z.number().optional().describe('Current weight to match (for edit)'),
          old_reps: z.number().optional().describe('Current reps to match (for edit)'),
          new_weight_lbs: z.number().optional().describe('New weight (for edit)'),
          new_reps: z.number().optional().describe('New reps (for edit)'),
          new_sets: z.number().optional().describe('New number of sets (for edit)')
        },
        async (args) => {
          switch (args.action) {
            case 'edit': {
              if (!args.exercise) return { content: [{ type: 'text', text: 'Exercise name required for edit.' }], isError: true };
              const result = await updateExercise(
                args.exercise,
                args.old_weight_lbs ?? null,
                args.old_reps ?? null,
                args.new_weight_lbs ?? null,
                args.new_reps ?? args.old_reps,
                args.new_sets ?? 1
              );
              if (!result.found) {
                return { content: [{ type: 'text', text: `No matching exercise "${args.exercise}" found today.` }] };
              }
              let text = `Updated ${args.exercise}: ${result.deletedSets} old set${result.deletedSets > 1 ? 's' : ''} → ${result.newSets} new set${result.newSets > 1 ? 's' : ''}`;
              if (result.todaySummary.length > 0) {
                text += '\n\nToday: ';
                text += result.todaySummary.map(s => {
                  let entry = s.exercise;
                  if (s.weightLbs) entry += ` ${s.weightLbs}`;
                  entry += ` ${s.sets}x${s.reps}`;
                  return entry;
                }).join(', ');
              }
              return { content: [{ type: 'text', text }] };
            }
            case 'delete': {
              if (!args.exercise) return { content: [{ type: 'text', text: 'Exercise name required for delete.' }], isError: true };
              const result = await deleteExercise(args.exercise, args.old_weight_lbs ?? null, args.old_reps ?? null);
              if (result.deletedSets === 0) {
                return { content: [{ type: 'text', text: `No "${args.exercise}" found in today's log.` }] };
              }
              let text = `Deleted ${result.deletedSets} set${result.deletedSets > 1 ? 's' : ''} of ${args.exercise}.`;
              if (result.todaySummary.length > 0) {
                text += '\n\nRemaining today: ';
                text += result.todaySummary.map(s => {
                  let entry = s.exercise;
                  if (s.weightLbs) entry += ` ${s.weightLbs}`;
                  entry += ` ${s.sets}x${s.reps}`;
                  return entry;
                }).join(', ');
              } else {
                text += '\n\nNo exercises logged today.';
              }
              return { content: [{ type: 'text', text }] };
            }
            case 'reset': {
              const result = await resetWorkoutHistory();
              return { content: [{ type: 'text', text: `Workout history cleared. ${result.deletedSets} total set${result.deletedSets !== 1 ? 's' : ''} removed.` }] };
            }
            case 'get_plan': {
              const plan = await getPlan();
              if (!plan) return { content: [{ type: 'text', text: 'No workout plan saved for today. Text "workout plan" to generate one.' }] };
              return { content: [{ type: 'text', text: `Today's plan:\n\n${plan.plan_text}` }] };
            }
            default:
              return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
          }
        }
      )
    ]
  });
}

// --- AGENT LOOP ---

/**
 * Handle an incoming SMS using the Claude Agent SDK
 * @param {Object} params
 * @param {string} params.message - Raw SMS body text
 * @param {string} params.fromNumber - Sender phone number
 * @param {string|null} params.imageCalorieResult - Pre-computed calorie result from image (if MMS)
 * @returns {Promise<{ reply: string }>}
 */
async function handleSMS({ message, fromNumber, imageCalorieResult }) {
  const requestStart = Date.now();

  const sdk = await getSDK();
  const history = await getRecentMessages(fromNumber);
  const toolServer = createToolServer(sdk, {});

  // Build prompt — include image calorie result if food photo was pre-processed
  let prompt = message || '(no text)';
  if (imageCalorieResult) {
    prompt = `[User sent a food photo. Calorie estimation result: ${imageCalorieResult}]\n\nUser's text: ${prompt}`;
  }

  let result = '';
  try {
    for await (const msg of sdk.query({
      prompt,
      options: {
        systemPrompt: buildSystemPrompt(history),
        mcpServers: { 'textpal-tools': toolServer },
        allowedTools: ['mcp__textpal-tools__*'],
        settingSources: ['project'],
        maxTurns: 10,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5-20250929'
      }
    })) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        result = msg.result;
      }
    }
  } catch (err) {
    console.error(`[AGENT] SDK error: ${err.message}`);
    result = 'Sorry, I could not process that. Text "how" for available commands.';
  }

  console.log(`[TIMING] agent-total: ${Date.now() - requestStart}ms`);

  const reply = result || 'Sorry, I could not process that.';
  await saveMessage(fromNumber, 'user', message || '(image)');
  await saveMessage(fromNumber, 'assistant', reply);
  return { reply };
}

module.exports = { handleSMS };
