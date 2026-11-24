/**
 * pollScheduler.js
 * ----------------
 * Chooses which Rocket.Chat rooms to poll on each tick.
 *
 * Rocket.Chat rate-limits `livechat/messages.history` (default: 10 calls per
 * 60 s per user), so polling every room on every tick returns 429 as soon as
 * there is more than one active room. The scheduler spends a fixed call budget
 * per tick on the most "overdue" rooms instead, so no room is starved:
 *
 *   priority = (time since last poll) x (hotWeight if the room is active)
 *
 * A room is "hot" when the customer wrote, or an agent message was seen,
 * within `hotWindowMs`. Hot rooms are polled more often, quiet rooms still get
 * a turn because their elapsed time keeps growing.
 */

// hotWeight 2: busy rooms are served twice as often, yet a quiet room waits at
// most ~3 ticks (about 30 s at the default interval) while another room is busy.
function createPollScheduler({ now = Date.now, hotWindowMs = 10 * 60 * 1000, hotWeight = 2 } = {}) {
  const lastPolled = new Map();
  const previous = new Map();

  const keyOf = (entry) => `${entry.platform}:${entry.platformUserId}`;

  function isHot(entry, time) {
    const last = Math.max(Number(entry.lastInboundAt) || 0, Number(entry.lastMessageTimestamp) || 0);
    return last > 0 && time - last <= hotWindowMs;
  }

  /** The `limit` entries that most deserve a poll right now. */
  function select(entries, limit) {
    const time = now();
    const count = Math.max(1, Math.floor(limit));
    return entries
      .map((entry, index) => {
        const elapsed = time - (lastPolled.get(keyOf(entry)) || 0);
        return { entry, index, priority: elapsed * (isHot(entry, time) ? hotWeight : 1) };
      })
      .sort((a, b) => b.priority - a.priority || a.index - b.index)
      .slice(0, count)
      .map((item) => item.entry);
  }

  function markPolled(entry) {
    const key = keyOf(entry);
    previous.set(key, lastPolled.get(key));
    lastPolled.set(key, now());
  }

  /** Undo markPolled: the request was refused (429), so the room was not served. */
  function release(entry) {
    const key = keyOf(entry);
    if (!previous.has(key)) return;
    const before = previous.get(key);
    if (before === undefined) lastPolled.delete(key);
    else lastPolled.set(key, before);
    previous.delete(key);
  }

  return { select, markPolled, release, isHot: (entry) => isHot(entry, now()) };
}

/** How many rooms may be polled per tick without exceeding the call budget. */
function callsPerTick(maxCallsPerMinute, tickMs) {
  return Math.max(1, Math.floor((Number(maxCallsPerMinute) * Number(tickMs)) / 60000));
}

module.exports = { callsPerTick, createPollScheduler };
