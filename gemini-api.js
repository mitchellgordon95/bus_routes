const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiCalorieAPI {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-3-pro-preview',
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' }
      }
    });
  }

  /**
   * Estimate calories for a food description
   * @param {string} foodDescription - Natural language food description
   * @returns {Promise<Object>} Calorie estimation result
   */
  async estimateCalories(foodDescription) {
    const prompt = this.buildPrompt(foodDescription);

    try {
      const genStart = Date.now();
      const result = await this.model.generateContent(prompt);
      console.log(`[TIMING] gemini-generateContent-text: ${Date.now() - genStart}ms`);
      const response = result.response.text();
      return this.parseResponse(response, foodDescription);
    } catch (error) {
      console.error('Gemini API Error:', error.message);
      throw new Error('Unable to estimate calories');
    }
  }

  /**
   * Estimate calories from a food image
   * @param {Buffer} imageBuffer - Image data as a buffer
   * @param {string} mimeType - MIME type of the image (e.g., 'image/jpeg')
   * @param {string} [textDescription] - Optional text description to accompany the image
   * @returns {Promise<Object>} Calorie estimation result
   */
  async estimateCaloriesFromImage(imageBuffer, mimeType, textDescription = '') {
    const prompt = this.buildImagePrompt(textDescription);

    try {
      const b64Start = Date.now();
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: mimeType
        }
      };
      console.log(`[TIMING] base64-encode: ${Date.now() - b64Start}ms (buffer size: ${imageBuffer.length} bytes)`);

      const genStart = Date.now();
      const result = await this.model.generateContent([prompt, imagePart]);
      console.log(`[TIMING] gemini-generateContent-image: ${Date.now() - genStart}ms`);
      const response = result.response.text();
      return this.parseResponse(response, textDescription || 'food image');
    } catch (error) {
      console.error('Gemini API Error:', error.message);
      throw new Error('Unable to estimate calories from image');
    }
  }

  /**
   * Get food suggestions for a calorie target
   * @param {number} calories - Target calories
   * @param {string} [descriptors] - Optional descriptors like "sweet", "savory", "healthy"
   * @returns {Promise<string>} Suggestions text
   */
  async getSuggestions(calories, descriptors = null) {
    const descriptorText = descriptors ? ` that are ${descriptors}` : '';
    const prompt = `Suggest 3-4 food options${descriptorText} that are approximately ${calories} calories each.

Keep it brief for SMS. Format as a simple list like:
• Food item 1 (~XXX cal)
• Food item 2 (~XXX cal)

No introductions or explanations, just the list.`;

    try {
      const genStart = Date.now();
      const result = await this.model.generateContent(prompt);
      console.log(`[TIMING] gemini-generateContent-suggestions: ${Date.now() - genStart}ms`);
      return result.response.text().trim();
    } catch (error) {
      console.error('Gemini API Error:', error.message);
      throw new Error('Unable to get suggestions');
    }
  }

  buildImagePrompt(textDescription) {
    const basePrompt = `You are a nutrition expert. Look at this food image and estimate the calories.`;
    const contextLine = textDescription
      ? `\n\nThe user also provided this description: "${textDescription}"`
      : '';

    return `${basePrompt}${contextLine}

Respond in this EXACT JSON format (no markdown, no code blocks):
{"items":[{"name":"item name","calories":123,"portion":"portion size"}],"totalCalories":456,"confidence":"high","notes":null}

Rules:
- Be concise, SMS has character limits
- Identify all visible food items in the image
- Estimate reasonable portion sizes based on visual cues
- If image is unclear or not food, set confidence to "low" and explain in notes
- Round calories to nearest 5
- confidence must be "high", "medium", or "low"`;
  }

  buildPrompt(foodDescription) {
    return `You are a nutrition expert. Estimate the calories for this food:

"${foodDescription}"

Respond in this EXACT JSON format (no markdown, no code blocks):
{"items":[{"name":"item name","calories":123,"portion":"portion size"}],"totalCalories":456,"confidence":"high","notes":null}

Rules:
- Be concise, SMS has character limits
- Use reasonable portion sizes if not specified
- If food is unclear, set confidence to "low" and ask for clarification in notes
- Round calories to nearest 5
- confidence must be "high", "medium", or "low"`;
  }

  /**
   * Parse Gemini response into structured format
   */
  parseResponse(responseText, originalInput) {
    try {
      // Clean the response (remove potential markdown formatting)
      const cleaned = responseText.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        success: true,
        items: parsed.items || [],
        totalCalories: parsed.totalCalories,
        confidence: parsed.confidence || 'medium',
        notes: parsed.notes || null,
        originalInput
      };
    } catch (error) {
      console.error('Failed to parse Gemini response:', responseText);
      return {
        success: false,
        error: 'Could not parse calorie estimate',
        rawResponse: responseText,
        originalInput
      };
    }
  }

  /**
   * Format calorie estimate as SMS-friendly text
   */
  formatAsText(result) {
    if (!result.success) {
      return `Sorry, I couldn't estimate calories for "${result.originalInput}". Try being more specific (e.g., "2 scrambled eggs" instead of "eggs").`;
    }

    let message = '';

    // List items with calories
    if (result.items.length === 1) {
      const item = result.items[0];
      message = `${item.name} (${item.portion}): ~${item.calories} cal`;
    } else {
      result.items.forEach(item => {
        message += `${item.name}: ~${item.calories} cal\n`;
      });
      message += `\nTotal: ~${result.totalCalories} cal`;
    }

    // Add confidence indicator for low confidence
    if (result.confidence === 'low') {
      message += '\n\n(Estimate uncertain - try being more specific)';
    }

    // Add notes if present and short
    if (result.notes && result.notes.length < 80) {
      message += `\n\n${result.notes}`;
    }

    return message;
  }
}

module.exports = GeminiCalorieAPI;
