const MESSAGES = {
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
  },
  telegram: {
    documentUploaded: (filename, chunks) =>
      `Document "${filename}" was uploaded (${chunks} chunk(s)). You can now ask questions about it.`,
    documentUploadFailed: "Sorry, I couldn't process your document right now. Please try again later.",
    unsupportedMessage: 'I received your content, but the bot currently reads only text messages and PDF/DOCX/text documents. A support agent can view this notice in the system.',
    uploadedDocumentStatus: (filename, mimeType, size, chunks) =>
      `📎 Telegram uploaded document: ${filename} (${mimeType}, ${size}). Indexed for AI with ${chunks} chunk(s), but the Rocket.Chat file upload did not complete.`,
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
