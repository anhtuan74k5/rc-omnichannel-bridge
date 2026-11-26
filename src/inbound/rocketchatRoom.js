const mapping = require('../core/mapping');
const rocketchat = require('../rocketchat/rocketchat');
const { resolveCustomerName } = require('../core/customerNames');

const roomEnsureMutexes = new Map();

async function ensureRocketChatRoom(platform, platformUserId, name) {
  const key = `${platform}:${String(platformUserId)}`;
  const previous = roomEnsureMutexes.get(key) || Promise.resolve();
  const task = async () => {
    const entry = mapping.getOrCreate(platform, platformUserId);
    // The name only matters while a visitor is registered (cached after the first lookup).
    const visitorName = entry.visitorToken && entry.roomId
      ? name
      : await resolveCustomerName(platform, platformUserId, name);
    const visitorToken = await rocketchat.getOrCreateVisitor(platformUserId, visitorName, { platform });
    // lastInboundAt marks the room "hot" so the poller serves it more often.
    mapping.update(entry, { visitorToken, lastInboundAt: Date.now() });

    const roomId = await rocketchat.getOrCreateRoom(visitorToken);
    mapping.update(entry, { roomId });

    return { entry, visitorToken, roomId };
  };
  const current = previous.then(task, task);
  roomEnsureMutexes.set(key, current);
  try {
    return await current;
  } finally {
    if (roomEnsureMutexes.get(key) === current) roomEnsureMutexes.delete(key);
  }
}

module.exports = { ensureRocketChatRoom };
