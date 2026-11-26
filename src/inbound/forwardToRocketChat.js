/**
 * Platform message -> Rocket.Chat (with the AI auto-reply in front).
 */

const mapping = require('../core/mapping');
const rocketchat = require('../rocketchat/rocketchat');
const ai = require('../knowledge/ai');
const { ENV } = require('../constants/config');
const { MESSAGES } = require('../constants/messages');
const metrics = require('../core/metrics');
const { rateLimiter } = require('../runtime');
const { ensureRocketChatRoom } = require('./rocketchatRoom');
const { sendReplyToPlatform } = require('../outbound/sendReply');

const AI_HANDOFF_MESSAGE = ENV.aiHandoffMessage || MESSAGES.ai.handoffDefault;

/** True while a human owns the conversation and the AI must not answer. */
function isAiPaused(entry) {
  if (!entry) return false;
  const last = Math.max(Number(entry.aiHandoffAt) || 0, Number(entry.agentActiveAt) || 0);
  return last > 0 && Date.now() - last < ENV.aiResumeAfterMs;
}

/**
 * Given a platform user id, name and platform, ensure the visitor + room
 * exist on Rocket.Chat, then send the message into the room.
 *
 * AI integration: before routing to a human agent, ask the AI if it can
 * handle the message automatically. If yes, the AI reply is sent to the
 * customer AND logged into the Rocket.Chat room (so the agent sees the full
 * AI conversation in Omnichannel). If no (or AI disabled), hand off to agent.
 */
async function forwardToRocketChat(platform, platformUserId, name, text, options = {}) {
  const timer = metrics.createTimer();
  try {
    await forwardToRocketChatInner(platform, platformUserId, name, text, options, timer);
  } finally {
    console.log(`[timing] ${platform}:${platformUserId} ${timer.summary()}`);
  }
}

async function forwardToRocketChatInner(platform, platformUserId, name, text, options, timer) {
  const known = mapping.findByPlatformUser(platform, platformUserId);

  // Per-customer rate limit: skip the message (and the AI) once a customer floods.
  const limit = rateLimiter.check(`${platform}:${platformUserId}`);
  if (!limit.allowed) {
    console.warn(`[ratelimit] Dropping message from ${platform}:${platformUserId}.`);
    if (limit.notify) {
      try {
        await sendReplyToPlatform(platform, platformUserId, MESSAGES.routing.rateLimited);
      } catch (err) {
        console.error(`[${platform}] Failed to send rate-limit notice:`, err.message);
      }
    }
    return;
  }

  // A customer edited an earlier message: show the agent the new text, but do
  // not run the AI or reply again.
  if (options.edited) {
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, MESSAGES.bridge.editedForRoom(text));
    } catch (err) {
      console.error(`[rocketchat] Failed to forward an edited message for ${platform}:${platformUserId}:`, err.message);
    }
    return;
  }

  // `/bot` hands the conversation back to the AI.
  if (ai.isEnabled() && /^\/bot$/i.test(String(text).trim())) {
    if (known) mapping.update(known, { aiHandoffAt: 0, agentActiveAt: 0 });
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, MESSAGES.ai.resumedForRoom);
    } catch (err) {
      console.error(`[rocketchat] Failed to log AI resume for ${platform}:${platformUserId}:`, err.message);
    }
    try {
      await sendReplyToPlatform(platform, platformUserId, MESSAGES.ai.resumed);
    } catch (err) {
      console.error(`[${platform}] Failed to confirm AI resume:`, err.message);
    }
    return;
  }

  // Once a human is involved the AI stays out of the way (until it times out or
  // the customer types /bot), otherwise it would answer between agent messages.
  const aiPaused = ai.isEnabled() && isAiPaused(known);

  // 0. Try AI auto-reply first (if enabled and not paused).
  let aiReply = null;
  let aiDeclined = false;
  if (ai.isEnabled() && !aiPaused) {
    try {
      const decision = await ai.askAI(text, { platform, platformUserId });
      if (decision.handled && decision.reply) {
        aiReply = decision.reply;
        console.log(`[ai] AI auto-replied to ${platform}:${platformUserId}.`);
      } else {
        aiDeclined = true;
        console.log(`[ai] AI cannot handle, handing off to agent for ${platform}:${platformUserId}.`);
      }
    } catch (err) {
      console.error('[ai] AI call failed, falling back to agent:', err.message);
    }
  }

  timer.mark('ai');
  try {
    const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);

    // 4. Send the visitor message into the room.
    await rocketchat.sendMessageToRocketChat(visitorToken, roomId, text);
    timer.mark('rocketchat');

    // 5. If AI handled it, also send the AI reply into the room so the agent
    //    can see the full AI conversation in Omnichannel, AND send it to the
    //    customer on the platform.
    if (aiReply) {
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.bridge.aiReplyForRoom(aiReply)
      );
      try {
        await sendReplyToPlatform(platform, platformUserId, aiReply);
        timer.mark('reply');
      } catch (err) {
        console.error(`[${platform}] Failed to send AI reply back to platform:`, err.message);
      }
    } else if (ai.isEnabled() && !aiPaused) {
      // Tell the customer once; from now on messages go straight to the agent.
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.bridge.aiHandoffForRoom(AI_HANDOFF_MESSAGE)
      );
      if (aiDeclined) {
        const entry = mapping.findByPlatformUser(platform, platformUserId);
        if (entry) mapping.update(entry, { aiHandoffAt: Date.now() });
      }
      try {
        await sendReplyToPlatform(platform, platformUserId, AI_HANDOFF_MESSAGE);
      } catch (err) {
        console.error(`[${platform}] Failed to send handoff notice back to platform:`, err.message);
      }
    }
  } catch (err) {
    if (!aiReply) {
      console.error(`[rocketchat] Failed to route message for ${platform}:${platformUserId}:`, err.message);
      try {
        await sendReplyToPlatform(
          platform,
          platformUserId,
          MESSAGES.routing.failed
        );
      } catch (sendErr) {
        console.error(`[${platform}] Failed to send routing error notice:`, sendErr.message);
      }
      return;
    }

    console.error(
      '[rocketchat] Failed to log AI-handled message, sending platform reply only:',
      err.message
    );
    try {
      await sendReplyToPlatform(platform, platformUserId, aiReply);
    } catch (sendErr) {
      console.error(`[${platform}] Failed to send AI reply back to platform:`, sendErr.message);
    }
  }
}

module.exports = { forwardToRocketChat, isAiPaused };
