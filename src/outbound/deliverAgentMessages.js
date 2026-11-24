/**
 * Agent -> customer delivery (shared by polling and the Rocket.Chat webhook).
 */

const mapping = require('../core/mapping');
const rocketchat = require('../rocketchat/rocketchat');
const facebook = require('../platforms/facebook');
const telegram = require('../platforms/telegram');
const { ENV } = require('../constants/config');
const { MESSAGES } = require('../constants/messages');
const { dumpRocketChatMessage } = require('../lib/debugDump');
const { downloadRocketChatFile, isPermanentDownloadError } = require('../media/rocketchatFiles');
const { classifyDeliveryError } = require('../core/deliveryErrors');
const { agentDeliveryQueue } = require('../runtime');
const { sendReplyToPlatform } = require('./sendReply');
const { sendAttachmentToPlatform, mediaDeliveryFailedMessage } = require('./sendAttachment');
const { alertCredentialsRejected, notifyDeliveryFailure } = require('./deliveryNotices');

const messageRetryCounts = new Map();
const MAX_PROCESSED_MESSAGE_IDS = 200;
const completedAttachmentKeys = new Map();

function markMessageProcessed(entry, messageId, timestamp) {
  const processedMessageIds = Array.isArray(entry.processedMessageIds)
    ? entry.processedMessageIds.filter((id) => id !== messageId)
    : [];
  if (messageId) processedMessageIds.push(messageId);
  entry.processedMessageIds = processedMessageIds.slice(-MAX_PROCESSED_MESSAGE_IDS);
  entry.lastMessageTimestamp = Math.max(entry.lastMessageTimestamp || 0, timestamp);
  mapping.update(entry, {
    lastMessageTimestamp: entry.lastMessageTimestamp,
    processedMessageIds: entry.processedMessageIds,
  });
}

/**
 * Deliver agent messages (from polling or the Rocket.Chat webhook) to the
 * customer's platform. Runs one at a time per customer, and skips messages the
 * other path already delivered, so webhook + polling never send twice.
 * Resolves `{ pending }`: true when a message is waiting for a retry.
 */
function deliverAgentMessages(entry, messages, closed = Boolean(messages.closed)) {
  return agentDeliveryQueue.enqueue(`${entry.platform}:${entry.platformUserId}`, async () => {
    const seen = new Set(entry.processedMessageIds || []);
    const newMessages = messages.filter((m) => !m._id || !seen.has(m._id));
    // A human answered: keep the AI quiet in this room for a while.
    if (newMessages.some((m) => (m.msg && m.msg !== 'connected') || rocketchat.extractAttachments(m).length > 0)) {
      mapping.update(entry, { agentActiveAt: Date.now() });
    }

    let deliveryPending = false; // a message is waiting for a retry
    for (const msg of newMessages) {
      try {
        dumpRocketChatMessage(msg);
      } catch (err) {
        console.warn('[poll] Failed to dump message payload:', err.message);
      }

      const text = msg.msg;
      const ts = new Date(msg.ts).getTime();
      const messageId = msg._id;
      const retryKey = `${entry.platform}:${entry.platformUserId}:${messageId || `${ts}:${text || ''}`}`;
      const attachments = rocketchat.extractAttachments(msg);
      const completed = completedAttachmentKeys.get(retryKey) || new Set();
      const pendingAttachments = attachments.filter((attachment) => !completed.has(attachment.source));

      if ((entry.platform === 'telegram' || entry.platform === 'facebook')
        && attachments.length > 0 && text !== 'connected') {
        let attachmentFailed = false;
        for (const attachment of pendingAttachments) {
          const attachmentRetryKey = `${retryKey}:${attachment.source}`;
          try {
            const downloaded = await downloadRocketChatFile(attachment.source);
            await sendAttachmentToPlatform(entry.platform, entry.platformUserId, {
              ...attachment,
              buffer: downloaded.buffer,
              mimeType: downloaded.mimeType || attachment.mimeType,
              filename: downloaded.filename || attachment.filename,
              size: downloaded.buffer.length,
            }, completed.size === 0 ? text : '');
            completed.add(attachment.source);
            messageRetryCounts.delete(attachmentRetryKey);
          } catch (err) {
            console.error(`[poll] Failed to forward attachment ${attachment.filename} to ${entry.platform}:`, err.message);
            const failure = classifyDeliveryError(entry.platform, err);
            if (failure.kind === 'auth') alertCredentialsRejected(entry.platform, failure.reason);
            const downloadFailed = isPermanentDownloadError(err);
            const permanent = downloadFailed || failure.kind === 'permanent';
            const retries = (messageRetryCounts.get(attachmentRetryKey) || 0) + 1;
            if (permanent || retries >= ENV.rocketChatMaxMessageRetries) {
              completed.add(attachment.source);
              messageRetryCounts.delete(attachmentRetryKey);
              await notifyDeliveryFailure(
                entry,
                `file "${attachment.filename}"`,
                downloadFailed ? 'không tải được file từ Rocket.Chat' : failure.reason
              );
            } else {
              messageRetryCounts.set(attachmentRetryKey, retries);
              attachmentFailed = true;
            }
            try {
              await sendReplyToPlatform(entry.platform, entry.platformUserId, mediaDeliveryFailedMessage(entry.platform, attachment.filename));
            } catch (noticeErr) {
              console.error('[poll] Failed to send attachment error notice:', noticeErr.message);
            }
            if (attachmentFailed) break;
          }
        }
        if (attachmentFailed) {
          completedAttachmentKeys.set(retryKey, completed);
          deliveryPending = true;
          continue;
        }
        completedAttachmentKeys.delete(retryKey);
        messageRetryCounts.delete(retryKey);
        markMessageProcessed(entry, messageId, ts);
        continue;
      }

      if (!text || text === 'connected') {
        markMessageProcessed(entry, messageId, ts);
        continue;
      }

      console.log(
        `[poll] New agent message in room ${entry.roomId} -> ${entry.platform}:${entry.platformUserId}`
      );

      try {
        if (entry.platform === 'facebook') {
          // Messenger has no formatting or date entity: plain text, split at 2000.
          await facebook.sendAgentMessage(entry.platformUserId, text, { timeZone: ENV.timezone });
        } else if (entry.platform === 'telegram') {
          // Agent text only: render Rocket.Chat Markdown (bold/italic/strike/code).
          await telegram.sendMessage(entry.platformUserId, text, { markdown: true });
        }
        messageRetryCounts.delete(retryKey);
        markMessageProcessed(entry, messageId, ts);
      } catch (err) {
        console.error(`[poll] Failed to forward message ${msg._id} to ${entry.platform}:`, err.message);
        const failure = classifyDeliveryError(entry.platform, err);
        if (failure.kind === 'auth') alertCredentialsRejected(entry.platform, failure.reason);
        const retries = (messageRetryCounts.get(retryKey) || 0) + 1;
        messageRetryCounts.set(retryKey, retries);
        // Retrying cannot fix a blocked customer or a closed 24 h window.
        if (failure.kind === 'permanent' || retries >= ENV.rocketChatMaxMessageRetries) {
          console.error(`[poll] Giving up on message ${msg._id} (${failure.kind}) after ${retries} attempt(s).`);
          messageRetryCounts.delete(retryKey);
          markMessageProcessed(entry, messageId, ts);
          await notifyDeliveryFailure(entry, 'tin nhắn', failure.reason);
        } else {
          deliveryPending = true;
          break;
        }
      }
    }

    // The agent closed the conversation and everything was delivered: stop
    // polling this room; the customer's next message opens a fresh one.
    if (closed && !deliveryPending) {
      // Webhook and polling can both report the close; only the first one
      // (the room is still set) tells the customer.
      const firstClose = Boolean(entry.roomId);
      mapping.update(entry, { roomId: null, ...rocketchat.roomStateReset() });
      console.log(`[poll] Conversation closed by the agent for ${entry.platform}:${entry.platformUserId}.`);
      if (firstClose && ENV.conversationClosedNotice) {
        try {
          await sendReplyToPlatform(
            entry.platform,
            entry.platformUserId,
            ENV.conversationClosedMessage || MESSAGES.bridge.conversationClosed
          );
        } catch (err) {
          console.error('[poll] Failed to send the conversation-closed notice:', err.message);
        }
      }
    }
    return { pending: deliveryPending };
  });
}

module.exports = { deliverAgentMessages, markMessageProcessed };
