/**
 * ai.js
 * -----
 * AI bot integration. When a customer sends a message, the AI tries to answer
 * automatically. If the AI cannot handle it (complex / needs human), it signals
 * a handoff to a human agent.
 *
 * Uses an OpenAI-compatible Chat Completions API (works with OpenAI, or any
 * compatible endpoint like a local LLM / Azure / Groq etc.).
 *
 * Env vars:
 *   AI_ENABLED=true|false
 *   AI_API_KEY=sk-...
 *   AI_BASE_URL=https://api.openai.com/v1   (optional, default OpenAI)
 *   AI_MODEL=gpt-4o-mini                    (optional, default gpt-4o-mini)
 */

const AI_ENABLED = process.env.AI_ENABLED === 'true';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

// System prompt instructing the AI when to auto-reply vs hand off to human.
const SYSTEM_PROMPT = `You are an AI customer-support assistant for a business.
You receive a customer message. Decide whether you can fully resolve it yourself.

Rules:
- If the message is a simple question (hours, prices, FAQ, greetings, thanks,
  basic info) -> answer it directly and concisely in the customer's language.
- If the message requires human judgment, account access, complaints, refunds,
  complex technical issues, or the customer explicitly asks for a human ->
  do NOT answer; signal handoff.

Respond ONLY with a JSON object, no other text:
{"handled": true, "reply": "your answer here"}
or
{"handled": false}`;

/**
 * Ask the AI whether it can handle the message.
 * Returns { handled: boolean, reply?: string }.
 */
async function askAI(customerMessage) {
  if (!AI_ENABLED) {
    return { handled: false };
  }
  if (!AI_API_KEY) {
    console.warn('[ai] AI_ENABLED=true but AI_API_KEY is missing. Skipping AI.');
    return { handled: false };
  }

  console.log(`[ai] Asking AI to handle: "${customerMessage}"`);
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: customerMessage },
      ],
      temperature: 0.3,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`AI API error ${res.status}: ${JSON.stringify(data)}`);
  }

  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';

  // Parse the JSON response from the AI.
  try {
    const parsed = JSON.parse(content);
    console.log(`[ai] AI decision: handled=${parsed.handled}`);
    return parsed;
  } catch (err) {
    console.warn('[ai] Could not parse AI response, defaulting to handoff:', content);
    return { handled: false };
  }
}

module.exports = {
  askAI,
  isEnabled: () => AI_ENABLED,
};
