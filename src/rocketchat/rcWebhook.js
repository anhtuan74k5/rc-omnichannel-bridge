/**
 * rcWebhook.js
 * ------------
 * Receiver for the Rocket.Chat Omnichannel webhook (Administration > Omnichannel
 * > Webhooks). Rocket.Chat POSTs JSON for every agent message, so the bridge can
 * push it to the customer at once instead of polling messages.history.
 *
 * Payload (Rocket.Chat 8.x, `sendToCRM`), authenticated by the header
 * `X-RocketChat-Livechat-Token: <Livechat_secret_token>`:
 *   - type "Message": `_id` = room id, `visitor.token`, `messages` = [ the one
 *     new message { _id, username, msg, ts, rid, agentId?, file?, attachments?,
 *     fileUpload? } ]. `agentId` is only present for messages sent by an agent.
 *   - type "LivechatSession": the room was closed; `messages` holds the whole
 *     history and is ignored.
 *   - "LivechatSessionStart" / "Queued" / "Taken" / "Forwarded" / "Edit" and
 *     "LeadCapture": only counted as a sign that the webhook is alive.
 *
 * Polling stays as a safety net: while the webhook is alive it runs at a low
 * rate, and as soon as the webhook has been silent for `silenceMs` it returns
 * to the normal rate. Delivery goes through the same `deliver` function as
 * polling, which skips already-delivered message ids, so nothing is sent twice.
 */

const crypto = require('crypto');

const TOKEN_HEADER = 'x-rocketchat-livechat-token';
const ALIVE_ONLY_TYPES = new Set([
  'LivechatSessionStart',
  'LivechatSessionQueued',
  'LivechatSessionTaken',
  'LivechatSessionForwarded',
  'LivechatEdit',
  'LeadCapture',
]);

function safeEqual(expected, received) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Turn a webhook body into what the bridge must do.
 * Returns { kind: 'agent-messages' | 'closed' | 'alive' | 'ignored', roomId, visitorToken, messages }.
 */
function parseEvent(body) {
  if (!body || typeof body !== 'object') return { kind: 'ignored' };
  const roomId = body._id || null;
  const visitorToken = (body.visitor && body.visitor.token) || null;
  const base = { roomId, visitorToken, messages: [] };

  if (body.type === 'LivechatSession') {
    // Only a real close counts; the same type is sent for other session updates.
    return body.closedAt ? { ...base, kind: 'closed' } : { ...base, kind: 'alive' };
  }
  if (ALIVE_ONLY_TYPES.has(body.type)) return { ...base, kind: 'alive' };
  if (body.type !== 'Message') return { ...base, kind: 'ignored' };

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    // No agentId: the customer's own message (echo of what the bridge sent).
    .filter((m) => m && m._id && m.agentId && !m.closingMessage)
    // `msg` becomes JSON of `blocks` for app messages; polling handles those.
    .filter((m) => !(Array.isArray(m.blocks) && m.blocks.length > 0 && !m.file))
    .map((m) => ({ ...m, msg: typeof m.msg === 'string' ? m.msg : '' }));

  return messages.length > 0
    ? { ...base, kind: 'agent-messages', messages }
    : { ...base, kind: 'alive' };
}

function createRocketChatWebhook({
  secret,
  silenceMs = 5 * 60 * 1000,
  fallbackPollMs = 60 * 1000,
  now = Date.now,
  findEntry,
  deliver,
  // Called with the entry whose room must be polled next (closed, or a push failed),
  // so it does not wait its turn behind every other open room.
  onUrgent = () => {},
  onError = () => {},
} = {}) {
  let lastEventAt = 0;
  let lastPollAt = 0;
  let forcePoll = false;
  const stats = { events: 0, delivered: 0, ignored: 0, rejected: 0 };

  const enabled = () => Boolean(secret);
  const alive = () => enabled() && lastEventAt > 0 && now() - lastEventAt < silenceMs;

  /**
   * Called by the polling loop on every tick; true when it should really poll.
   * Webhook alive: one poll per `fallbackPollMs`, or at once after a failed push.
   */
  function shouldPoll() {
    if (!alive()) return true;
    const time = now();
    if (forcePoll || time - lastPollAt >= fallbackPollMs) {
      forcePoll = false;
      lastPollAt = time;
      return true;
    }
    return false;
  }

  async function handleEvent(event) {
    const entry = findEntry(event);
    if (!entry) {
      stats.ignored += 1;
      return;
    }
    if (event.kind === 'agent-messages') {
      const result = await deliver(entry, event.messages, false);
      stats.delivered += event.messages.length;
      // A failed push is retried by polling on its next tick.
      if (result && result.pending) {
        onUrgent(entry);
        forcePoll = true;
      }
    } else if (event.kind === 'closed') {
      // Let polling close the room: it also sees messages still waiting for a retry.
      onUrgent(entry);
      forcePoll = true;
    }
  }

  /** Express handler for POST /webhook/rocketchat. */
  function handler(req, res) {
    if (!enabled()) return res.status(503).send('Rocket.Chat webhook is disabled');
    if (!safeEqual(secret, req.get(TOKEN_HEADER))) {
      stats.rejected += 1;
      console.warn('[rc-webhook] Rejected request with missing or invalid token.');
      return res.sendStatus(401);
    }

    // Answer 200 at once (Rocket.Chat retries anything else) and work afterwards.
    res.status(200).send('ok');
    lastEventAt = now();
    stats.events += 1;

    const event = parseEvent(req.body);
    if (event.kind === 'ignored') stats.ignored += 1;
    if (event.kind === 'agent-messages' || event.kind === 'closed') {
      handleEvent(event).catch((err) => onError(err, event));
    }
  }

  return {
    handler,
    shouldPoll,
    isAlive: alive,
    isEnabled: enabled,
    status: () => ({ enabled: enabled(), alive: alive(), lastEventAt, ...stats }),
  };
}

module.exports = { createRocketChatWebhook, parseEvent, TOKEN_HEADER };
