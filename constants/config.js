const CHANNELS = Object.freeze({
  facebook: 'facebook',
  telegram: 'telegram',
});

const DEFAULTS = Object.freeze({
  port: 3000,
  pollingIntervalMs: 10000,
  telegramPollIntervalMs: 2000,
  requestBodyLimit: '2mb',
  webhookBodyLimit: '1mb',
  rateLimitPerMinute: 20,
  telegramMaxDocumentBytes: 100 * 1024 * 1024,
  telegramMaxMediaBytes: 20 * 1024 * 1024,
  // Messenger Send API accepts attachments up to 25 MB.
  facebookMaxMediaBytes: 25 * 1024 * 1024,
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  aiResumeAfterMinutes: 30,
  aiTimeoutMs: 30000,
  timezone: 'Asia/Bangkok',
  documentChunkSize: 1200,
  documentChunkOverlap: 150,
  documentTopK: 4,
  documentSummaryTopK: 8,
  httpTimeoutMs: 15000,
  httpUploadTimeoutMs: 120000,
  maxOutboundMediaBytes: 50 * 1024 * 1024,
  telegramMaxUpdateRetries: 3,
  rocketChatMaxMessageRetries: 3,
  rocketChatPollIntervalMs: 10000,
  // Rocket.Chat's default API limit is 10 calls/60 s per endpoint; stay below it.
  rocketChatPollMaxCallsPerMinute: 8,
  rocketChatHotWindowMs: 10 * 60 * 1000,
  telegramWebhookPath: '/webhook/telegram',
});

// Base URLs can be overridden (e.g. to point at scripts/e2e/mock-platforms.js).
const trimUrl = (value, fallback) => String(value || fallback).trim().replace(/\/+$/, '');
const TELEGRAM_BASE_URL = trimUrl(process.env.TELEGRAM_API_BASE_URL, 'https://api.telegram.org');
const FB_GRAPH_BASE_URL = trimUrl(process.env.FB_GRAPH_BASE_URL, 'https://graph.facebook.com');

const API = Object.freeze({
  telegram: {
    baseUrl: TELEGRAM_BASE_URL,
    fileBaseUrl: `${TELEGRAM_BASE_URL}/file`,
    allowedUpdates: ['message', 'edited_message'],
  },
  facebook: {
    graphBaseUrl: FB_GRAPH_BASE_URL,
    graphVersion: 'v25.0',
  },
  rocketChat: {
    loginPath: '/api/v1/login',
    visitorPath: '/api/v1/livechat/visitor',
    roomPath: '/api/v1/livechat/room',
    messagePath: '/api/v1/livechat/message',
    uploadPath: '/api/v1/livechat/upload',
    messagesHistoryPath: '/api/v1/livechat/messages.history',
  },
});

const HEADERS = Object.freeze({
  contentType: 'Content-Type',
  authToken: 'X-Auth-Token',
  userId: 'X-User-Id',
  visitorToken: 'x-visitor-token',
  accept: 'Accept',
  userAgent: 'User-Agent',
});

const MIME_TYPES = Object.freeze({
  octetStream: 'application/octet-stream',
});

const FILES = Object.freeze({
  defaultDocument: 'document.txt',
  defaultUpload: 'document',
});

const DOCUMENT_EXTENSIONS = Object.freeze([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.conf',
  '.env',
  '.pdf',
  '.docx',
]);

const TELEGRAM_MESSAGE_TYPES = Object.freeze([
  'photo',
  'sticker',
  'voice',
  'audio',
  'video',
  'video_note',
  'animation',
  'contact',
  'location',
  'venue',
]);

const ENV = Object.freeze({
  rocketchatUrl: process.env.ROCKETCHAT_URL || '',
  agentUsername: process.env.ROCKETCHAT_AGENT_USERNAME || '',
  agentPassword: process.env.ROCKETCHAT_AGENT_PASSWORD || '',
  authToken: process.env.ROCKETCHAT_AUTH_TOKEN || '',
  userId: process.env.ROCKETCHAT_USER_ID || '',
  departmentId: process.env.ROCKETCHAT_DEPARTMENT_ID || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL || '',
  telegramAllowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  adminApiKey: process.env.ADMIN_API_KEY || '',
  facebookPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN || '',
  facebookVerifyToken: process.env.FB_VERIFY_TOKEN || '',
  // App Secret used to verify X-Hub-Signature-256 on incoming webhooks.
  facebookAppSecret: process.env.FB_APP_SECRET || '',
  facebookMaxMediaBytes: Number(
    process.env.FB_MAX_MEDIA_BYTES || DEFAULTS.facebookMaxMediaBytes
  ),
  debugPolling: process.env.DEBUG_POLLING === 'true',
  debugDumpPayloads: process.env.DEBUG_DUMP_PAYLOADS === 'true',
  telegramMaxDocumentBytes: Number(
    process.env.TELEGRAM_MAX_DOCUMENT_BYTES || DEFAULTS.telegramMaxDocumentBytes
  ),
  telegramMaxMediaBytes: Number(
    process.env.TELEGRAM_MAX_MEDIA_BYTES || DEFAULTS.telegramMaxMediaBytes
  ),
  // Render Rocket.Chat Markdown in agent -> Telegram messages; set to 'false' to send raw text.
  telegramRenderMarkdown: process.env.TELEGRAM_RENDER_MARKDOWN !== 'false',
  telegramPollingEnabled: process.env.TELEGRAM_POLLING === 'true',
  telegramPollIntervalMs: Number(
    process.env.TELEGRAM_POLL_INTERVAL_MS || DEFAULTS.telegramPollIntervalMs
  ),
  port: process.env.PORT || DEFAULTS.port,
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || DEFAULTS.requestBodyLimit,
  // Public webhooks never need a large body; only /documents/upload uses requestBodyLimit.
  webhookBodyLimit: process.env.WEBHOOK_BODY_LIMIT || DEFAULTS.webhookBodyLimit,
  // Messages per customer per minute; 0 disables the limit.
  rateLimitPerMinute: Math.max(0, Number(process.env.RATE_LIMIT_PER_MINUTE || DEFAULTS.rateLimitPerMinute)),
  aiEnabled: process.env.AI_ENABLED === 'true',
  aiApiKey: process.env.AI_API_KEY || '',
  aiBaseUrl: (process.env.AI_BASE_URL || DEFAULTS.aiBaseUrl).replace(/\/+$/, ''),
  aiModel: process.env.AI_MODEL || DEFAULTS.aiModel,
  aiBusinessContext: (process.env.AI_BUSINESS_CONTEXT || '').trim(),
  aiHandoffMessage: process.env.AI_HANDOFF_MESSAGE || '',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || DEFAULTS.aiTimeoutMs),
  // After a handoff or an agent reply the AI stays silent in that room for this long.
  aiResumeAfterMs: Math.max(
    0,
    Number(process.env.AI_RESUME_AFTER_MINUTES || DEFAULTS.aiResumeAfterMinutes) * 60 * 1000
  ),
  timezone: process.env.TZ || DEFAULTS.timezone,
  documentChunkSize: Number(process.env.DOCUMENT_CHUNK_SIZE || DEFAULTS.documentChunkSize),
  documentChunkOverlap: Number(process.env.DOCUMENT_CHUNK_OVERLAP || DEFAULTS.documentChunkOverlap),
  documentTopK: Number(process.env.DOCUMENT_TOP_K || DEFAULTS.documentTopK),
  documentSummaryTopK: Number(process.env.DOCUMENT_SUMMARY_TOP_K || DEFAULTS.documentSummaryTopK),
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || DEFAULTS.httpTimeoutMs),
  httpUploadTimeoutMs: Number(process.env.HTTP_UPLOAD_TIMEOUT_MS || DEFAULTS.httpUploadTimeoutMs),
  maxOutboundMediaBytes: Number(
    process.env.MAX_OUTBOUND_MEDIA_BYTES || DEFAULTS.maxOutboundMediaBytes
  ),
  telegramMaxUpdateRetries: Math.max(
    1,
    Number(process.env.TELEGRAM_MAX_UPDATE_RETRIES || DEFAULTS.telegramMaxUpdateRetries)
  ),
  rocketChatMaxMessageRetries: Math.max(
    1,
    Number(process.env.ROCKETCHAT_MAX_MESSAGE_RETRIES || DEFAULTS.rocketChatMaxMessageRetries)
  ),
  rocketChatPollIntervalMs: Math.max(
    10000,
    Number(process.env.ROCKETCHAT_POLL_INTERVAL_MS || DEFAULTS.rocketChatPollIntervalMs)
  ),
  rocketChatPollMaxCallsPerMinute: Math.max(
    1,
    Number(process.env.ROCKETCHAT_POLL_MAX_CALLS_PER_MINUTE || DEFAULTS.rocketChatPollMaxCallsPerMinute)
  ),
  rocketChatHotWindowMs: Math.max(
    0,
    Number(process.env.ROCKETCHAT_HOT_WINDOW_MS || DEFAULTS.rocketChatHotWindowMs)
  ),
});

module.exports = {
  API,
  CHANNELS,
  DEFAULTS,
  DOCUMENT_EXTENSIONS,
  ENV,
  FILES,
  HEADERS,
  MIME_TYPES,
  TELEGRAM_MESSAGE_TYPES,
};
