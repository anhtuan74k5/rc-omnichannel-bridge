/**
 * index.js
 * --------
 * Bridge entry point (`npm start`). The implementation lives in src/:
 * see README.md ("Cấu trúc chính") for the layout.
 *
 * Exposes:
 *  - GET  /webhook/facebook  (Facebook webhook verification)
 *  - POST /webhook/facebook  (Facebook incoming messages)
 *  - POST /webhook/telegram  (Telegram incoming messages)
 *  - POST /webhook/rocketchat, GET /health, /documents*
 *
 * Also re-exports the pieces the tests use.
 */

// Load .env before any module reads process.env at require time.
require('dotenv').config();

const { app } = require('./src/app');
const { authorizeAdmin } = require('./src/auth');
const { rcWebhook, facebookQueue } = require('./src/runtime');
const { deliverAgentMessages } = require('./src/outbound/deliverAgentMessages');
const { forwardToRocketChat, isAiPaused } = require('./src/inbound/forwardToRocketChat');
const { start } = require('./src/server');

if (require.main === module) start();

module.exports = { app, authorizeAdmin, deliverAgentMessages, rcWebhook, facebookQueue, forwardToRocketChat, isAiPaused, start };
