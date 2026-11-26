const MESSAGES = {
  bridge: {
    telegramUnsupportedCaption: (caption) =>
      caption && caption.trim() ? ` Caption: "${caption.trim()}"` : '',
    telegramUnsupportedRoomMessage: (messageType, captionText) =>
      `[Telegram ${messageType}] User sent a ${messageType} message.${captionText} This bridge currently forwards text and supported documents only.`,
    deliveryFailed: (platform, what, reason) =>
      `⚠️ [Bridge] Không gửi được ${what} tới khách trên ${platform}: ${reason}.`,
    editedForRoom: (text) => `✏️ (khách đã sửa tin) ${text}`,
    conversationClosed:
      'Cuộc trò chuyện đã kết thúc. Nếu cần hỗ trợ thêm, bạn cứ nhắn tin lại nhé!',
    unsupportedFileType: (platform) =>
      `${platform === 'facebook' ? 'Messenger' : 'Nền tảng này'} không hỗ trợ gửi loại file này (ví dụ file nén .zip). Vui lòng gửi dạng ảnh, PDF, video, âm thanh hoặc đường dẫn.`,
    aiReplyForRoom: (reply) => `🤖 AI: ${reply}`,
    aiHandoffForRoom: (message) => `🤖 AI: ${message}`,
    liveLookupContext: (context) =>
      `Live lookup result. Use this for the answer and mention the source briefly if useful:\n${context}`,
    documentExcerpts: (excerpts, question) =>
      `Document excerpts:\n${excerpts}\n\nCustomer question:\n${question}`,
    documentExcerpt: (index, filename, text) =>
      `Excerpt ${index} from ${filename}:\n${text}`,
    businessContextMissing:
      'Business context: not configured. Do not invent products, hours, prices, policies, address, or contact details.',
    politicalLookupContext: 'Live political office lookup from Wikipedia:',
    wikipediaPage: (title) => `Page: ${title}`,
    incumbent: (value) => `Incumbent: ${value}`,
    incumbentSince: (value) => `Incumbent since: ${value}`,
    summary: (value) => `Summary: ${value}`,
    source: (value) => `Source: ${value}`,
    weatherLookupContext: (placeName) => `Live weather lookup from Open-Meteo for ${placeName}:`,
    weatherTime: (time) => `Time: ${time}`,
    weatherCondition: (condition) => `Condition: ${condition}`,
    weatherTemperature: (temperature) => `Temperature: ${temperature} C`,
    weatherHumidity: (humidity) => `Humidity: ${humidity}%`,
    weatherWindSpeed: (speed) => `Wind speed: ${speed} km/h`,
    weatherSource: 'Source: Open-Meteo geocoding and forecast APIs.',
    wikidataLookupContext: 'Live political office lookup from Wikidata:',
    country: (country) => `Country: ${country}`,
    officeType: (office) => `Office type: ${office}`,
    currentHolders: (holders) => `Current holder(s): ${holders}`,
    wikidataSource: 'Source: Wikidata SPARQL query for current statement without end date.',
    weatherCode: (code) => `weather code ${code}`,
  },
  ai: {
    handoffDefault: "I don't have enough information to answer accurately. I've forwarded your message to a support agent. Please wait a moment.",
    start: 'Hello! I can answer simple questions, check the weather, look up some current information, read PDF/DOCX/text documents you send, or connect you with a support agent when needed.',
    help: [
      'You can send a question directly, for example:',
      '- What is the weather like in Hanoi today?',
      '- Who is the current president of the United States?',
      '- Summarize the file I just sent',
      '- Connect me with a support agent',
      'The bot currently reads text messages and PDF/DOCX/text documents.',
    ].join('\n'),
    systemPrompt: `You are an AI customer-support assistant for a business.
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
{"handled": false}`,
    documentSystemPrompt: `You are an AI customer-support assistant for a business.
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
{"handled": false}`,
    resumed: 'Trợ lý AI đã được bật lại. Bạn có thể tiếp tục đặt câu hỏi.',
    resumedForRoom: '🤖 Khách đã bật lại trợ lý AI bằng lệnh /bot.',
    runtimeDateTime: (dateTime) => `Current server date/time: ${dateTime}`,
    runtimeTimezone: (timezone) => `Timezone: ${timezone}`,
    liveLookupResult: (context) =>
      `Live lookup result. Use this for the answer and mention the source briefly if useful:\n${context}`,
  },
  telegram: {
    documentUploaded: (filename, chunks) =>
      `Document "${filename}" was uploaded (${chunks} chunk(s)). You can now ask questions about it.`,
    unsupportedMessage: 'I cannot pass on this kind of content yet. A support agent can see a notice about it in the system.',
    mediaDeliveryFailed: 'Sorry, I could not deliver one of the support files right now. Please try again later.',
    mediaTooLarge: 'This media file is too large. Please send a file up to 20 MB.',
    mediaUploadFailed: 'Sorry, I could not upload this media right now. Please try again later.',
    mediaUploadStatus: (type, filename, reason) =>
      `[Telegram ${type}] Failed to upload "${filename}" to Rocket.Chat: ${reason}`,
  },
  facebook: {
    mediaTooLarge: 'This file is too large. Please send a file up to 25 MB.',
    mediaUploadFailed: 'Sorry, I could not upload this file right now. Please try again later.',
    mediaDeliveryFailed: 'Sorry, I could not deliver one of the support files right now. Please try again later.',
    mediaUploadStatus: (type, filename, reason) =>
      `[Facebook ${type}] Failed to upload "${filename}" to Rocket.Chat: ${reason}`,
    unsupportedRoomMessage: (type) =>
      `[Facebook ${type}] User sent a ${type} message that this bridge cannot forward.`,
    locationRoomMessage: (title, url) =>
      `[Facebook location] ${title ? `${title}: ` : ''}${url}`,
  },
  liveLookup: {
    weatherLocationPrompt: 'Which location would you like the weather for? For example: "What is the weather like in Hanoi today?"',
    weatherLocationNotFound: (location) => `I couldn't find the location "${location}". Please provide a clearer city or province name.`,
    weather: (placeName, weatherText, temperature, humidity, windSpeed, time) => [
      `Current weather in ${placeName}: ${weatherText}, ${temperature}°C.`,
      `Humidity ${humidity}%, wind ${windSpeed} km/h.`,
      `Updated at ${time}. Source: Open-Meteo.`,
    ],
    officeTypePrompt: 'Which country would you like to ask about?',
    wikipediaSource: (title, incumbent, incumbentSince, source) =>
      `${title}: ${incumbent}${incumbentSince ? `, in office since ${incumbentSince}` : ''}. Source: Wikipedia (${source}).`,
  },
  routing: {
    rateLimited: "You are sending messages too quickly. Please slow down; some messages were skipped.",
    failed: "I received your message, but the support system is currently unavailable. Please try again in a few minutes.",
  },
};

const WEATHER_CODES = new Map([
  [0, 'clear sky'],
  [1, 'mainly clear'],
  [2, 'partly cloudy'],
  [3, 'overcast'],
  [45, 'fog'],
  [48, 'depositing rime fog'],
  [51, 'light drizzle'],
  [53, 'moderate drizzle'],
  [55, 'dense drizzle'],
  [61, 'slight rain'],
  [63, 'moderate rain'],
  [65, 'heavy rain'],
  [71, 'slight snow fall'],
  [73, 'moderate snow fall'],
  [75, 'heavy snow fall'],
  [80, 'slight rain showers'],
  [81, 'moderate rain showers'],
  [82, 'violent rain showers'],
  [95, 'thunderstorm'],
  [96, 'thunderstorm with slight hail'],
  [99, 'thunderstorm with heavy hail'],
]);

module.exports = { MESSAGES, WEATHER_CODES };
