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

const documents = require('./documents');
const liveLookup = require('./liveLookup');
const { ENV } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { MESSAGES } = require('./constants/messages');

const AI_ENABLED = ENV.aiEnabled;
const AI_API_KEY = ENV.aiApiKey;
const AI_BASE_URL = ENV.aiBaseUrl;
const AI_MODEL = ENV.aiModel;
const AI_BUSINESS_CONTEXT = ENV.aiBusinessContext;

/* const SYSTEM_PROMPT = `You are an AI customer-support assistant for a business.
Your job is to resolve common customer questions, collect useful context, and
route to a human only when automation is not appropriate.

Rules:
- Reply in the same language as the customer.
- Keep replies concise, friendly, and practical.
- Answer greetings, thanks, simple arithmetic, and low-risk general questions
  directly when you are confident.
- Answer simple stable general-knowledge questions, definitions, translations,
  short writing help, and basic reasoning questions when you are confident.
- Answer business-specific facts such as products, opening hours, prices,
  policies, addresses, promotions, and contact details only if they are present
  in the provided business context, document excerpts, or customer message.
- Never invent business details and never output placeholder text.
- For unclear support requests, ask one specific clarifying question instead of
  handing off immediately.
- For harmless off-topic small talk, answer briefly. For broad off-topic tasks,
  gently redirect toward product/service support.
- Do not claim access to live/current data, private account data, order data, or
  internal systems unless it is provided in the message. You may use the
  provided current date/time context for date/time questions, but not for live
  news, weather, politics, market prices, or external facts that can change.
- For current or fast-changing external facts, say you do not have live lookup
  access and suggest checking an official/current source. Do not hand off unless
  it is related to the business support case.
- Signal handoff only when the customer asks for a human, or the request needs
  human judgment/action such as billing disputes, refunds, complaints, account
  access, security incidents, legal/medical/financial advice, or complex
  troubleshooting.

Respond ONLY with a JSON object, no other text:
{"handled": true, "reply": "your answer here"}
or
{"handled": false}`; */

/* const DOCUMENT_SYSTEM_PROMPT = `You are an AI customer-support assistant for a business.
The customer has uploaded private documents. Use the provided document excerpts
when they are relevant to the customer's question.

Rules:
- Reply in the same language as the customer.
- If the answer is clearly supported by the excerpts, answer directly and
  concisely.
- Never invent business details and never output placeholder text.
- If the customer appears to be asking about the document but the excerpts are
  not enough, ask one specific clarifying question if that can recover the
  conversation.
- If the document question still cannot be answered safely, signal handoff.
- For greetings, thanks, simple arithmetic, and clearly off-topic questions, use
  the normal support behavior: answer simple stable questions or redirect
  politely instead of pretending the document contains the answer.
- For current or fast-changing external facts, say you do not have live lookup
  access and suggest checking an official/current source.
- Never mention internal chunk ids.

Respond ONLY with a JSON object, no other text:
{"handled": true, "reply": "your answer here"}
or
{"handled": false}`; */

const SYSTEM_PROMPT = MESSAGES.ai.systemPrompt;
const DOCUMENT_SYSTEM_PROMPT = MESSAGES.ai.documentSystemPrompt;

function buildDocumentContext(chunks) {
  return chunks
    .map((chunk, index) => {
      return MESSAGES.bridge.documentExcerpt(index + 1, chunk.filename, chunk.text);
    })
    .join('\n\n---\n\n');
}

function buildRuntimeContext() {
  const now = new Date();
  const timezone = ENV.timezone;
  const currentDateTime = new Intl.DateTimeFormat('vi-VN', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);

  const lines = [
    MESSAGES.ai.runtimeDateTime(currentDateTime),
    MESSAGES.ai.runtimeTimezone(timezone),
  ];

  if (AI_BUSINESS_CONTEXT) {
    lines.push(`Business context:\n${AI_BUSINESS_CONTEXT}`);
  } else {
    lines.push(MESSAGES.bridge.businessContextMissing);
  }

  return lines.join('\n');
}

function getStaticReply(customerMessage) {
  const text = String(customerMessage || '').trim().toLowerCase();
  if (text === '/start' || text === 'start') {
    return MESSAGES.ai.start;
  }

  if (text === '/help' || text === 'help') {
    return MESSAGES.ai.help;
  }

  return '';
}

/**
 * Ask the AI whether it can handle the message.
 * Returns { handled: boolean, reply?: string }.
 */
async function askAI(customerMessage, context = {}) {
  const staticReply = getStaticReply(customerMessage);
  if (staticReply) {
    return { handled: true, reply: staticReply };
  }

  if (!AI_ENABLED) {
    return { handled: false };
  }
  if (!AI_API_KEY) {
    console.warn('[ai] AI_ENABLED=true but AI_API_KEY is missing. Skipping AI.');
    return { handled: false };
  }

  let messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: buildRuntimeContext() },
    { role: 'user', content: customerMessage },
  ];
  const liveContext = await liveLookup.getLiveContext(customerMessage);
  if (liveContext && liveContext.directReply) {
    console.log('[ai] Live lookup returned a direct reply.');
    return { handled: true, reply: liveContext.directReply };
  }
  if (liveContext && liveContext.context) {
    console.log('[ai] Live lookup context available.');
    messages.splice(2, 0, {
      role: 'system',
      content: MESSAGES.ai.liveLookupResult(liveContext.context),
    });
  }

  if (!liveContext && context.platform && context.platformUserId) {
    const retrieval = documents.retrieveRelevantChunks(
      context.platform,
      context.platformUserId,
      customerMessage
    );

    if (retrieval.hasDocuments) {
      if (retrieval.chunks.length === 0) {
        console.log(`[ai] Documents exist but no relevant context for ${context.platform}:${context.platformUserId}.`);
      } else {
        console.log(
          `[ai] Using ${retrieval.chunks.length} document chunk(s) for ${context.platform}:${context.platformUserId}.`
        );
        messages = [
          { role: 'system', content: DOCUMENT_SYSTEM_PROMPT },
          { role: 'system', content: buildRuntimeContext() },
          {
            role: 'user',
            content: MESSAGES.bridge.documentExcerpts(
              buildDocumentContext(retrieval.chunks),
              customerMessage
            ),
          },
        ];
      }
    }
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
      messages,
      temperature: 0.3,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(ERRORS.ai.api(res.status, data));
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
