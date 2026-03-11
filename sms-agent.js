const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_AGENT_ITERATIONS = 10;

// Import existing backends (used inside tool handlers)
const MTABusAPI = require('./mta-api');
const GeminiCalorieAPI = require('./gemini-api');
const { addCalories, subtractCalories, getTodayTotal, resetToday, getTarget, setTarget } = require('./calorie-tracker');
const {
  savePendingRide,
  getPendingRide,
  clearPendingRide,
  saveActiveRide,
  getActiveRide,
  clearActiveRide,
  savePendingAuth,
  getPendingAuth,
  clearPendingAuth
} = require('./uber-pending');
const { getUberQuote, confirmUberRide, getUberStatus, cancelUberRide } = require('./uber-agent');
const { logSets, getExerciseCaloriesToday, getWorkoutHistory, updateExercise, deleteExercise, resetWorkoutHistory, savePlan, getPlan } = require('./workout-tracker');
const { saveMessage, getRecentMessages } = require('./conversation-history');

// --- SYSTEM PROMPT ---
const SYSTEM_PROMPT = `You are TextPal, a personal SMS assistant. You help users via text message with:
1. NYC bus arrival times
2. Calorie tracking
3. Uber rides
4. General questions
5. Workout tracking & planning

HOW TO RECOGNIZE REQUESTS:

Bus Stops:
- A 6-digit number (e.g., "308209") is an MTA bus stop code. Call lookup_bus_arrivals.
- May include a route filter after the code: "308209 B63"
- May have prefixes like "bus 308209", "stop 308209", "check 308209"

Food & Calorie Tracking:
- Text descriptions of food eaten (e.g., "2 eggs and toast", "grande latte", "chicken parm with pasta") should be logged. Call estimate_calories.
- Photos of food (image attached) should be logged. Call estimate_calories_from_image.
- If the user sends BOTH a food photo AND a text description, call estimate_calories_from_image with the text as text_context. Do NOT also call estimate_calories separately.
- "total" -> Call get_calorie_status to show today's total
- "sub 50" or "subtract 50" -> Call update_calories with action "subtract" and amount 50
- "reset calories" -> Call update_calories with action "reset"
- "target 2000" -> Call update_calories with action "set_target" and amount 2000
- "suggest 300" or "suggest 300 sweet" -> Call get_food_suggestions
- When someone texts food, assume they ate it and want it logged unless they clearly say otherwise (e.g., "how many calories in a banana" without eating context is still logged).

Uber Rides:
- "uber [pickup] to [destination]" -> Call request_uber_quote
- "uber confirm" or "uber confirm 2" or "uber confirm comfort" -> Call manage_uber_ride with action "confirm"
- "uber status" -> Call manage_uber_ride with action "status"
- "uber cancel" -> Call manage_uber_ride with action "cancel"
- "uber auth 123456" or "uber code 123456" -> Call manage_uber_ride with action "auth"

Workout Tracking:
- Exercise descriptions like "bench 45 3x8", "squat 55 5x5", "pull-ups 3x10" → Call log_exercise
- Natural language like "did 3 sets of 8 on bench at 45" → Call log_exercise
- Parse the exercise name, weight, reps, and sets from whatever format the user provides
- Users may log one set at a time. Each log accumulates with previous sets of the same exercise today.
- Users may rate difficulty: easy (progress next time), medium (on track), hard (hold or reduce). Include in log_exercise if mentioned.
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
- The user has an adjustable dumbbell set (15, 25, 35, 45, 55 lbs), a workout bench, and a pull-up bar. No barbell, no cable machine. Only suggest exercises doable with this equipment using these exact weights.
- Look at recent history to determine which muscle groups need work
- Use difficulty ratings from history to guide progression: easy → increase weight, medium → add reps, hard → hold or reduce
- Suggest progressive overload (slightly more weight or reps than last time)
- Include specific exercises, weights, sets, and reps based on the user's previous performance
- If no history exists, ask about experience level and goals to create a starter plan

General Questions:
- For anything that doesn't match the above, respond conversationally without calling any tools.
- You can answer general knowledge questions, give advice, chat, etc.

RESPONSE RULES:
- Keep responses SHORT and SMS-friendly. Plain text only, no markdown.
- Use line breaks to separate sections.
- If a tool result contains "async": true, respond with ONLY the acknowledgment text from the tool. Do not add anything else.
- When the user texts "how" or "?", list the available commands:

Bus Times: Send 6-digit stop code (e.g., 308209). Add route to filter (e.g., 308209 B63).
Calories: Send food description or photo. "total" for daily count. "sub 50" to subtract. "target 2000" to set goal. "suggest 300" for ideas. "reset calories" to start over.
Workout: "bench 185 3x8" to log. "change bench to 190 3x8" to edit. "delete bench" to remove. "workout plan" for today's plan. "workout summary" for history. "reset workout history" to clear all.
Uber: "uber [pickup] to [dest]" for quote. "uber confirm 1" to book. "uber status" / "uber cancel".`;

// --- TOOL DEFINITIONS ---
const TOOLS = [
  {
    name: 'lookup_bus_arrivals',
    description: 'Look up real-time bus arrivals at an MTA bus stop. Use when the user provides a 6-digit stop code.',
    input_schema: {
      type: 'object',
      properties: {
        stop_code: { type: 'string', description: '6-digit MTA bus stop code' },
        route: { type: 'string', description: 'Optional bus route filter (e.g., B63, M15)' }
      },
      required: ['stop_code']
    }
  },
  {
    name: 'estimate_calories',
    description: 'Estimate calories for a food description, log them, and return the daily total. Use when the user describes food in text without an image.',
    input_schema: {
      type: 'object',
      properties: {
        food_description: { type: 'string', description: 'Natural language food description (e.g., "2 eggs and toast")' }
      },
      required: ['food_description']
    }
  },
  {
    name: 'estimate_calories_from_image',
    description: 'Estimate calories from a food photo, log them, and return the daily total. Use when the user sends an image (with or without accompanying text).',
    input_schema: {
      type: 'object',
      properties: {
        text_context: { type: 'string', description: 'Optional text the user sent along with the photo' }
      },
      required: []
    }
  },
  {
    name: 'get_calorie_status',
    description: 'Get today\'s calorie total and daily target. Use when user texts "total".',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'update_calories',
    description: 'Modify calorie tracking: subtract calories, reset daily count, or set daily target.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['subtract', 'reset', 'set_target'],
          description: 'The action to perform'
        },
        amount: {
          type: 'number',
          description: 'Calorie amount (required for subtract and set_target)'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'get_food_suggestions',
    description: 'Get food suggestions for a calorie budget. Use when user texts "suggest 300" or "suggest 300 sweet".',
    input_schema: {
      type: 'object',
      properties: {
        calories: { type: 'number', description: 'Target calories per suggestion' },
        descriptors: { type: 'string', description: 'Optional descriptors like "sweet", "savory", "healthy"' }
      },
      required: ['calories']
    }
  },
  {
    name: 'request_uber_quote',
    description: 'Get an Uber price quote for a trip. This is an async operation - returns immediately with an acknowledgment, results come via follow-up SMS.',
    input_schema: {
      type: 'object',
      properties: {
        pickup: { type: 'string', description: 'Pickup address or location' },
        destination: { type: 'string', description: 'Destination address or location' }
      },
      required: ['pickup', 'destination']
    }
  },
  {
    name: 'manage_uber_ride',
    description: 'Manage an Uber ride: confirm booking, check status, cancel, or enter SMS auth code.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['confirm', 'status', 'cancel', 'auth'],
          description: 'The action to perform'
        },
        selection: {
          type: 'string',
          description: 'For confirm: product number (e.g., "1") or product name (e.g., "comfort")'
        },
        auth_code: {
          type: 'string',
          description: 'For auth: the SMS verification code from Uber'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'log_exercise',
    description: 'Log weight lifting sets. Use when the user reports exercises they did.',
    input_schema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'Exercise name (e.g., "bench press", "squat", "pull-ups")' },
        weight_lbs: { type: 'number', description: 'Weight in pounds. Omit or 0 for bodyweight exercises.' },
        reps: { type: 'number', description: 'Reps per set' },
        sets: { type: 'number', description: 'Number of sets (default 1). Users often log one set at a time.' },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'], description: 'How difficult the set felt. Optional.' }
      },
      required: ['exercise', 'reps']
    }
  },
  {
    name: 'get_workout_history',
    description: 'Get recent workout history. Use this to generate workout plans or show exercise summaries.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days of history to fetch (default 14)' }
      },
      required: []
    }
  },
  {
    name: 'save_workout_plan',
    description: 'Save today\'s workout plan. Call this after generating a workout plan for the user.',
    input_schema: {
      type: 'object',
      properties: {
        plan_text: { type: 'string', description: 'The full workout plan text to save' }
      },
      required: ['plan_text']
    }
  },
  {
    name: 'manage_workout',
    description: 'Edit, delete, or reset workout entries, or retrieve today\'s plan.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit', 'delete', 'reset', 'get_plan'], description: 'The action to perform' },
        exercise: { type: 'string', description: 'Exercise name to edit/delete' },
        old_weight_lbs: { type: 'number', description: 'Current weight to match (for edit)' },
        old_reps: { type: 'number', description: 'Current reps to match (for edit)' },
        new_weight_lbs: { type: 'number', description: 'New weight (for edit)' },
        new_reps: { type: 'number', description: 'New reps (for edit)' },
        new_sets: { type: 'number', description: 'New number of sets (for edit)' }
      },
      required: ['action']
    }
  }
];

// --- TOOL HANDLERS ---
// Each handler receives (input, ctx) where ctx has { fromNumber, twilioNumber, imageBuffer, imageMediaType, sendAsyncSMS }

const toolHandlers = {
  async lookup_bus_arrivals(input, ctx) {
    const mtaAPI = new MTABusAPI(process.env.MTA_API_KEY);
    const arrivalData = await mtaAPI.getStopArrivals(input.stop_code, input.route || null);
    return { result: mtaAPI.formatAsText(arrivalData) };
  },

  async estimate_calories(input, ctx) {
    const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
    const calorieData = await geminiAPI.estimateCalories(input.food_description);
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
    return { result: text };
  },

  async estimate_calories_from_image(input, ctx) {
    if (!ctx.imageBuffer) {
      return { error: 'No image attached to this message.' };
    }
    const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
    const calorieData = await geminiAPI.estimateCaloriesFromImage(
      ctx.imageBuffer, ctx.imageMediaType, input.text_context || ''
    );
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
    return { result: text };
  },

  async get_calorie_status(input, ctx) {
    const [total, baseTarget, exerciseCals] = await Promise.all([
      getTodayTotal(), getTarget(), getExerciseCaloriesToday()
    ]);
    const adjustedTarget = baseTarget + exerciseCals;
    const text = exerciseCals > 0
      ? `Today's total: ${total} / ${adjustedTarget} cal (${baseTarget} + ${exerciseCals} exercise)`
      : `Today's total: ${total} / ${baseTarget} cal`;
    return { result: text };
  },

  async update_calories(input, ctx) {
    switch (input.action) {
      case 'subtract': {
        const [newTotal, baseTarget, exerciseCals] = await Promise.all([
          subtractCalories(input.amount), getTarget(), getExerciseCaloriesToday()
        ]);
        const adjustedTarget = baseTarget + exerciseCals;
        const display = exerciseCals > 0
          ? `${newTotal} / ${adjustedTarget} cal (${baseTarget} + ${exerciseCals} exercise)`
          : `${newTotal} / ${baseTarget} cal`;
        return { result: `Subtracted ${input.amount} cal.\n\nDaily total: ${display}` };
      }
      case 'reset': {
        const previous = await resetToday();
        return { result: `Daily calories reset. Previous total was ${previous} cal.` };
      }
      case 'set_target': {
        const newTarget = await setTarget(input.amount);
        return { result: `Daily target set to ${newTarget} cal.` };
      }
      default:
        return { error: `Unknown action: ${input.action}` };
    }
  },

  async get_food_suggestions(input, ctx) {
    const geminiAPI = new GeminiCalorieAPI(process.env.GEMINI_API_KEY);
    const text = await geminiAPI.getSuggestions(input.calories, input.descriptors || null);
    return { result: text };
  },

  async log_exercise(input, ctx) {
    const result = await logSets(
      input.exercise,
      input.weight_lbs || null,
      input.reps,
      input.sets || 1,
      input.difficulty || null
    );

    const [baseTarget, exerciseCals] = await Promise.all([
      getTarget(), getExerciseCaloriesToday()
    ]);
    const adjustedTarget = baseTarget + exerciseCals;

    let text = `Logged: ${result.exercise}`;
    if (result.weightLbs) text += ` ${result.weightLbs} lbs`;
    text += ` - ${result.setsLogged} set${result.setsLogged > 1 ? 's' : ''} of ${result.reps}`;
    if (input.difficulty) text += ` (${input.difficulty})`;
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

    return { result: text };
  },

  async get_workout_history(input, ctx) {
    const history = await getWorkoutHistory(input.days || 14);
    if (history.length === 0) {
      return { result: 'No workout history found. Start logging exercises to build your history!' };
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
    return { result: text };
  },

  async save_workout_plan(input, ctx) {
    await savePlan(input.plan_text);
    return { result: 'Plan saved.' };
  },

  async manage_workout(input, ctx) {
    switch (input.action) {
      case 'edit': {
        if (!input.exercise) return { error: 'Exercise name required for edit.' };
        const result = await updateExercise(
          input.exercise,
          input.old_weight_lbs ?? null,
          input.old_reps ?? null,
          input.new_weight_lbs ?? null,
          input.new_reps ?? input.old_reps,
          input.new_sets ?? 1
        );
        if (!result.found) {
          return { result: `No matching exercise "${input.exercise}" found today.` };
        }
        let text = `Updated ${input.exercise}: ${result.deletedSets} old set${result.deletedSets > 1 ? 's' : ''} → ${result.newSets} new set${result.newSets > 1 ? 's' : ''}`;
        if (result.todaySummary.length > 0) {
          text += '\n\nToday: ';
          text += result.todaySummary.map(s => {
            let entry = s.exercise;
            if (s.weightLbs) entry += ` ${s.weightLbs}`;
            entry += ` ${s.sets}x${s.reps}`;
            return entry;
          }).join(', ');
        }
        return { result: text };
      }
      case 'delete': {
        if (!input.exercise) return { error: 'Exercise name required for delete.' };
        const result = await deleteExercise(input.exercise, input.old_weight_lbs ?? null, input.old_reps ?? null);
        if (result.deletedSets === 0) {
          return { result: `No "${input.exercise}" found in today's log.` };
        }
        let text = `Deleted ${result.deletedSets} set${result.deletedSets > 1 ? 's' : ''} of ${input.exercise}.`;
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
        return { result: text };
      }
      case 'reset': {
        const result = await resetWorkoutHistory();
        return { result: `Workout history cleared. ${result.deletedSets} total set${result.deletedSets !== 1 ? 's' : ''} removed.` };
      }
      case 'get_plan': {
        const plan = await getPlan();
        if (!plan) return { result: 'No workout plan saved for today. Text "workout plan" to generate one.' };
        return { result: `Today's plan:\n\n${plan.plan_text}` };
      }
      default:
        return { error: `Unknown action: ${input.action}` };
    }
  },

  async request_uber_quote(input, ctx) {
    // Fire async operation, return immediately
    (async () => {
      try {
        const quote = await getUberQuote(input.pickup, input.destination);

        if (quote.requiresAuth) {
          await savePendingAuth(ctx.fromNumber, 'quote', {
            pickup: input.pickup,
            destination: input.destination
          });
          await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
            'Uber needs SMS verification. Check your texts from Uber, then reply: uber auth <code>');
          return;
        }

        await savePendingRide(ctx.fromNumber, quote);

        let msg = `Uber from ${quote.pickup.address} to ${quote.destination.address}:\n\n`;
        const products = quote.products || [];
        products.slice(0, 5).forEach((p, i) => {
          msg += `${i + 1}. ${p.name} - ${p.price} (${p.eta})\n`;
        });
        if (products.length > 0) {
          msg += `\nReply "uber confirm 1" to book ${products[0].name}`;
        } else {
          msg += `No products available. Try a different route.`;
        }

        await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber, msg);
      } catch (error) {
        console.error('Uber quote error:', error.message);
        await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
          error.message || 'Could not get Uber quote. Check your addresses.');
      }
    })();

    return { async: true, acknowledgment: 'Getting Uber quote... (this may take a moment)' };
  },

  async manage_uber_ride(input, ctx) {
    switch (input.action) {
      case 'confirm': {
        const pendingRide = await getPendingRide(ctx.fromNumber);
        if (!pendingRide) {
          return { result: 'No pending Uber ride. Text "uber [pickup] to [destination]" first.' };
        }

        const selection = input.selection || '1';
        let productIndex = 0;
        if (/^\d+$/.test(selection)) {
          productIndex = parseInt(selection, 10) - 1;
        } else {
          productIndex = pendingRide.products.findIndex(
            p => p.name.toLowerCase() === selection.toLowerCase()
          );
        }

        if (productIndex < 0 || productIndex >= pendingRide.products.length) {
          return { result: `Invalid selection. Choose 1-${pendingRide.products.length} or product name.` };
        }

        const selectedProduct = pendingRide.products[productIndex];

        // Fire async
        (async () => {
          try {
            const ride = await confirmUberRide(pendingRide, productIndex);
            await saveActiveRide(ctx.fromNumber, ride.requestId);
            await clearPendingRide(ctx.fromNumber);
            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
              `Uber booked!\n\nDriver: ${ride.driverName}\nVehicle: ${ride.vehicle}\nETA: ${ride.eta}\n\nText "uber status" for updates.`);
          } catch (error) {
            console.error('Uber confirm error:', error.message);
            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
              error.message || 'Could not book Uber. Try again.');
          }
        })();

        return { async: true, acknowledgment: `Booking ${selectedProduct.name} for ${selectedProduct.price}...` };
      }

      case 'status': {
        const activeRequestId = await getActiveRide(ctx.fromNumber);
        if (!activeRequestId) {
          // Check for pending ride (fast DB lookup)
          const pending = await getPendingRide(ctx.fromNumber);
          if (pending && pending.products?.length > 0) {
            const firstProduct = pending.products[0];
            return { result: `Pending: ${firstProduct.name} ${firstProduct.price}\nFrom: ${pending.pickup.address}\nTo: ${pending.destination.address}\n\nReply "uber confirm" to book.` };
          } else if (pending) {
            return { result: `Pending ride from ${pending.pickup.address} to ${pending.destination.address}\n\nReply "uber confirm" to book.` };
          }
          return { result: 'No active Uber ride. Text "uber [pickup] to [destination]" to get started.' };
        }

        // Active ride - check status async
        (async () => {
          try {
            const status = await getUberStatus(activeRequestId);
            const msg = `Uber Status: ${status.status}\n\nDriver: ${status.driverName || 'Assigned'}\nETA: ${status.eta || 'Calculating...'}`;
            if (['completed', 'rider_canceled', 'driver_canceled'].includes(status.status)) {
              await clearActiveRide(ctx.fromNumber);
            }
            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber, msg);
          } catch (error) {
            console.error('Uber status error:', error.message);
            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
              error.message || 'Could not get ride status.');
          }
        })();

        return { async: true, acknowledgment: 'Checking ride status...' };
      }

      case 'cancel': {
        // Check active ride first
        const activeId = await getActiveRide(ctx.fromNumber);
        if (activeId) {
          (async () => {
            try {
              await cancelUberRide(activeId);
              await clearActiveRide(ctx.fromNumber);
              await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber, 'Uber ride canceled.');
            } catch (error) {
              console.error('Uber cancel error:', error.message);
              await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
                error.message || 'Could not cancel ride.');
            }
          })();
          return { async: true, acknowledgment: 'Canceling your Uber...' };
        }

        // Check pending ride (sync - fast DB op)
        const pendingToCancel = await getPendingRide(ctx.fromNumber);
        if (pendingToCancel) {
          await clearPendingRide(ctx.fromNumber);
          return { result: 'Pending Uber request cleared.' };
        }

        return { result: 'No active or pending Uber ride to cancel.' };
      }

      case 'auth': {
        const pendingAuth = await getPendingAuth(ctx.fromNumber);
        if (!pendingAuth) {
          return { result: 'No pending Uber auth. Request a ride first with "uber [pickup] to [destination]".' };
        }

        // Fire async
        (async () => {
          try {
            const quote = await getUberQuote(pendingAuth.pickup, pendingAuth.destination, input.auth_code);
            await clearPendingAuth(ctx.fromNumber);

            if (quote.requiresAuth) {
              await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
                'Auth still required. Check your texts from Uber and reply: uber auth <code>');
              return;
            }

            await savePendingRide(ctx.fromNumber, quote);

            let msg = `Uber from ${quote.pickup.address} to ${quote.destination.address}:\n\n`;
            const products = quote.products || [];
            products.slice(0, 5).forEach((p, i) => {
              msg += `${i + 1}. ${p.name} - ${p.price} (${p.eta})\n`;
            });
            if (products.length > 0) {
              msg += `\nReply "uber confirm 1" to book ${products[0].name}`;
            } else {
              msg += `No products available. Try a different route.`;
            }

            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber, msg);
          } catch (error) {
            console.error('Uber auth error:', error.message);
            await ctx.sendAsyncSMS(ctx.fromNumber, ctx.twilioNumber,
              error.message || 'Auth failed. Try again.');
          }
        })();

        return { async: true, acknowledgment: 'Entering auth code and getting quote...' };
      }

      default:
        return { error: `Unknown Uber action: ${input.action}` };
    }
  }
};

// --- AGENT LOOP ---

/**
 * Handle an incoming SMS using the Claude routing agent
 * @param {Object} params
 * @param {string} params.message - Raw SMS body text
 * @param {string} params.fromNumber - Sender phone number
 * @param {string} params.twilioNumber - The Twilio number (req.body.To)
 * @param {Buffer|null} params.imageBuffer - Pre-fetched image data
 * @param {string|null} params.imageMediaType - MIME type of image
 * @param {Function} params.sendAsyncSMS - Function to send async SMS(to, from, body)
 * @returns {Promise<{ reply: string, isAsync: boolean }>}
 */
async function handleSMS({ message, fromNumber, twilioNumber, imageBuffer, imageMediaType, sendAsyncSMS }) {
  const requestStart = Date.now();
  const ctx = { fromNumber, twilioNumber, imageBuffer, imageMediaType, sendAsyncSMS };

  // Build initial message content
  const userContent = [];
  if (imageBuffer) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMediaType,
        data: imageBuffer.toString('base64')
      }
    });
  }
  userContent.push({ type: 'text', text: message || '(image with no text)' });

  // Load conversation history for context continuity
  const history = await getRecentMessages(fromNumber);
  const messages = [...history, { role: 'user', content: userContent }];

  let iterations = 0;
  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;

    const apiStart = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });
    console.log(`[TIMING] agent-api-call-${iterations}: ${Date.now() - apiStart}ms`);

    // If end_turn with no tool calls, extract text response
    if (response.stop_reason === 'end_turn') {
      let textBlock = response.content.find(c => c.type === 'text');
      // If no text in final response, check if the previous assistant turn had text
      // (happens when Claude generates text + tool_use, then end_turn with no text)
      if (!textBlock?.text && messages.length >= 2) {
        const prevAssistant = messages[messages.length - 2];
        if (prevAssistant.role === 'assistant' || Array.isArray(prevAssistant.content)) {
          const prevContent = Array.isArray(prevAssistant.content) ? prevAssistant.content : prevAssistant;
          const prevText = prevContent.find?.(c => c.type === 'text');
          if (prevText?.text) textBlock = prevText;
        }
      }
      console.log(`[TIMING] agent-total: ${Date.now() - requestStart}ms (${iterations} iteration${iterations > 1 ? 's' : ''})`);
      const reply = textBlock?.text || 'Sorry, I could not process that.';
      await saveMessage(fromNumber, 'user', userContent);
      await saveMessage(fromNumber, 'assistant', reply);
      return { reply, isAsync: false };
    }

    // Execute tool calls
    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find(c => c.type === 'text');
      console.log(`[TIMING] agent-total: ${Date.now() - requestStart}ms (no tools, ${iterations} iteration${iterations > 1 ? 's' : ''})`);
      const reply = textBlock?.text || 'Sorry, I could not process that.';
      await saveMessage(fromNumber, 'user', userContent);
      await saveMessage(fromNumber, 'assistant', reply);
      return { reply, isAsync: false };
    }

    const toolResults = [];
    let asyncResult = null;

    for (const block of toolUseBlocks) {
      const handler = toolHandlers[block.name];
      if (!handler) {
        console.error(`[AGENT] Unknown tool: ${block.name}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
          is_error: true
        });
        continue;
      }

      console.log(`[AGENT] Tool: ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`);
      const toolStart = Date.now();

      try {
        const result = await handler(block.input, ctx);
        console.log(`[AGENT]   -> ${Date.now() - toolStart}ms`);

        if (result.async) {
          asyncResult = result;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      } catch (err) {
        console.error(`[AGENT]   -> ERROR: ${err.message} (${Date.now() - toolStart}ms)`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: err.message }),
          is_error: true
        });
      }
    }

    // If an async tool was called, short-circuit without another Claude API call
    if (asyncResult) {
      console.log(`[TIMING] agent-total: ${Date.now() - requestStart}ms (async short-circuit)`);
      await saveMessage(fromNumber, 'user', userContent);
      await saveMessage(fromNumber, 'assistant', asyncResult.acknowledgment);
      return { reply: asyncResult.acknowledgment, isAsync: true };
    }

    // Feed results back to Claude for response formatting
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  console.log(`[TIMING] agent-total: ${Date.now() - requestStart}ms (max iterations reached)`);
  const fallbackReply = 'Sorry, I could not process that. Text "how" for available commands.';
  await saveMessage(fromNumber, 'user', userContent);
  await saveMessage(fromNumber, 'assistant', fallbackReply);
  return { reply: fallbackReply, isAsync: false };
}

module.exports = { handleSMS };
