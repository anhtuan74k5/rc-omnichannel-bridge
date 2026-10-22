const ERRORS = {
  telegram: {
    tokenMissing: 'TELEGRAM_BOT_TOKEN is missing',
    updateFailed: (status, data) => `Telegram getUpdates failed (${status}): ${JSON.stringify(data)}`,
    unsupportedDocument: (extension, extensions) =>
      `Unsupported document type "${extension || 'unknown'}". Please upload one of: ${extensions.join(', ')}.`,
    documentTooLarge: (maxBytes) => `Document is too large. Max size is ${maxBytes} bytes.`,
    fileInfoFailed: (status, data) => `Telegram getFile failed (${status}): ${JSON.stringify(data)}`,
    fileDownloadFailed: (status) => `Telegram file download failed (${status})`,
    sendFailed: (status, data) => `Telegram send failed (${status}): ${JSON.stringify(data)}`,
  },
  facebook: {
    sendFailed: (status, data) => `Facebook send failed (${status}): ${JSON.stringify(data)}`,
  },
  rocketchat: {
    api: (status, text) => `Rocket.Chat API error ${status}: ${text}`,
    loginFailed: (status, body) => `Login failed (${status}): ${JSON.stringify(body)}`,
    visitorFailed: (body) => `Failed to create visitor: ${JSON.stringify(body)}`,
    roomFailed: (body) => `Failed to get room: ${JSON.stringify(body)}`,
    messageFailed: (body) => `Failed to send message: ${JSON.stringify(body)}`,
    uploadInvalidBuffer: 'buffer must be a non-empty Buffer',
    uploadFailed: (status, text) => `Rocket.Chat livechat upload failed (${status}): ${text}`,
  },
  documents: {
    requiredContent: 'content must be a non-empty string',
    requiredIdentity: 'platform and platformUserId are required',
    invalidBuffer: 'buffer must be a non-empty Buffer',
    unreadableContent: (filename) => `Could not extract readable text from "${filename}".`,
    unsupportedDocument: (extension) => `Unsupported document type "${extension || 'unknown'}".`,
  },
  ai: {
    api: (status, data) => `AI API error ${status}: ${JSON.stringify(data)}`,
  },
};

module.exports = { ERRORS };
