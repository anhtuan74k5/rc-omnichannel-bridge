/**
 * Polling loop: forward agent messages to the correct platform.
 */

const mapping = require('../core/mapping');
const rocketchat = require('../rocketchat/rocketchat');
const { ENV } = require('../constants/config');
const { callsPerTick } = require('../rocketchat/pollScheduler');
const metrics = require('../core/metrics');
const { pollScheduler, rcWebhook } = require('../runtime');
const { deliverAgentMessages } = require('./deliverAgentMessages');

const POLL_INTERVAL_MS = ENV.rocketChatPollIntervalMs;
let agentPollingInProgress = false;
let rocketChatPollingNotBefore = 0;

async function pollAgentMessages() {
  if (agentPollingInProgress) return;
  if (Date.now() < rocketChatPollingNotBefore) return;
  // The Rocket.Chat webhook pushes agent messages; poll only as a safety net.
  if (!rcWebhook.shouldPoll()) return;
  agentPollingInProgress = true;
  metrics.set('lastAgentPollAt', Date.now());

  try {
  const activeEntries = mapping.getActiveEntries().filter((entry) => entry.roomId && entry.visitorToken);
  if (activeEntries.length === 0) return;

  // Rocket.Chat rate-limits messages.history, so spend a fixed call budget per
  // tick on the rooms that most need a poll instead of polling all of them.
  const entries = pollScheduler.select(
    activeEntries,
    callsPerTick(ENV.rocketChatPollMaxCallsPerMinute, POLL_INTERVAL_MS)
  );

  for (const entry of entries) {
    try {
      pollScheduler.markPolled(entry);
      const newMessages = await rocketchat.pollNewAgentMessages(
        entry.roomId,
        entry.visitorToken,
        entry.lastMessageTimestamp,
        entry.processedMessageIds || []
      );

      await deliverAgentMessages(entry, newMessages);
    } catch (err) {
      console.error(`[poll] Error polling room ${entry.roomId}:`, err.message);
      if (err.status === 429) {
        // The room was refused, not served: keep it first in line for next time.
        pollScheduler.release(entry);
        const retryAfterSeconds = Number(
          String(err.body && err.body.error || err.message).match(/wait\s+(\d+)\s+seconds?/i)?.[1]
        );
        const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds
          : 10) * 1000;
        rocketChatPollingNotBefore = Date.now() + cooldownMs;
        console.warn(`[poll] Rocket.Chat rate limit reached; pausing polling for ${Math.ceil(cooldownMs / 1000)}s.`);
        break;
      }
    }

  }
  } finally {
    agentPollingInProgress = false;
  }
}

module.exports = { pollAgentMessages };
