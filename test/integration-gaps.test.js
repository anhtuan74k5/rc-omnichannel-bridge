const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMock } = require('../scripts/e2e/mock-platforms');

const mappingFile = path.join(os.tmpdir(), `gaps-mapping-${process.pid}.json`);
const mock = createMock();
let facebook;
let mapping;
let deliverAgentMessages;
let mediaDeliveryFailedMessage;
let MESSAGES;

function loadTelegram() {
  delete require.cache[require.resolve('../src/platforms/telegram')];
  return require('../src/platforms/telegram');
}

test.before(async () => {
  const port = await mock.listen(0);
  process.env.FB_GRAPH_BASE_URL = `http://127.0.0.1:${port}/`;
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.FB_PAGE_ACCESS_TOKEN = 'mock-page-token';
  process.env.TELEGRAM_BOT_TOKEN = '123:mock-bot-token';
  process.env.HTTP_TIMEOUT_MS = '1000';
  process.env.MAPPING_FILE = mappingFile;
  facebook = require('../src/platforms/facebook');
  ({ MESSAGES } = require('../src/constants/messages'));
  mapping = require('../src/core/mapping');
  ({ deliverAgentMessages } = require('../src/outbound/deliverAgentMessages'));
  ({ mediaDeliveryFailedMessage } = require('../src/outbound/sendAttachment'));
  mapping.load();
});
test.after(async () => {
  await mock.close();
  for (const file of [mappingFile, `${mappingFile}.tgoffset`]) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
});
test.beforeEach(() => {
  mock.clear();
  delete process.env.FB_HUMAN_AGENT_TAG;
  delete process.env.CONVERSATION_CLOSED_NOTICE;
});

const sends = (route) => mock.requests.filter((r) => r.route === route);

// ---------------------------------------------------------- HUMAN_AGENT tag

test('outside the 24 h window the reply is not retried unless the tag is enabled', async () => {
  mock.inject('facebook', 'fb-10');
  await assert.rejects(() => facebook.sendMessage('PSID', 'late reply'));
  assert.equal(sends('me/messages').length, 1);
  assert.match(sends('me/messages')[0].json, /"messaging_type":"RESPONSE"/);
});

test('with FB_HUMAN_AGENT_TAG the late reply is retried once with the HUMAN_AGENT tag', async () => {
  process.env.FB_HUMAN_AGENT_TAG = 'true';
  mock.inject('facebook', 'fb-10');
  const data = await facebook.sendMessage('PSID', 'late reply');
  assert.match(data.message_id, /^m_mock_/);
  const [first, second] = sends('me/messages');
  assert.match(first.json, /"messaging_type":"RESPONSE"/);
  assert.match(second.json, /"messaging_type":"MESSAGE_TAG"/);
  assert.match(second.json, /"tag":"HUMAN_AGENT"/);
});

test('the tag is not used for unrelated errors (blocked customer)', async () => {
  process.env.FB_HUMAN_AGENT_TAG = 'true';
  mock.inject('facebook', 'fb-551');
  await assert.rejects(() => facebook.sendMessage('PSID', 'x'));
  assert.equal(sends('me/messages').length, 1);
});

test('if Meta still refuses the tagged retry the error reaches the caller', async () => {
  process.env.FB_HUMAN_AGENT_TAG = 'true';
  mock.inject('facebook', 'fb-10', 2);
  await assert.rejects(() => facebook.sendMessage('PSID', 'x'));
  assert.equal(sends('me/messages').length, 2);
});

// ------------------------------------------------------ unsupported file type

test('archives get a clear "not supported" notice on Messenger, other files the generic one', () => {
  assert.equal(mediaDeliveryFailedMessage('facebook', 'backup.ZIP'), MESSAGES.bridge.unsupportedFileType('facebook'));
  assert.match(MESSAGES.bridge.unsupportedFileType('facebook'), /Messenger.*\.zip/);
  assert.equal(mediaDeliveryFailedMessage('facebook', 'doc.pdf'), MESSAGES.facebook.mediaDeliveryFailed);
  assert.equal(mediaDeliveryFailedMessage('telegram', 'backup.zip'), MESSAGES.telegram.mediaDeliveryFailed);
});

// ----------------------------------------------------- conversation closed notice

test('closing the conversation tells the customer exactly once', async () => {
  const entry = mapping.getOrCreate('telegram', '4242');
  mapping.update(entry, { roomId: 'room-closed-1', visitorToken: 'v' });

  await deliverAgentMessages(entry, [], true);
  assert.equal(sends('sendMessage').length, 1, 'customer notified on the first close');
  assert.equal(entry.roomId, null);

  await deliverAgentMessages(entry, [], true); // webhook + polling both report the close
  assert.equal(sends('sendMessage').length, 1, 'not notified a second time');
});

test('the closed notice can be turned off', async () => {
  process.env.CONVERSATION_CLOSED_NOTICE = 'false';
  const entry = mapping.getOrCreate('telegram', '4343');
  mapping.update(entry, { roomId: 'room-closed-2', visitorToken: 'v' });
  await deliverAgentMessages(entry, [], true);
  assert.equal(sends('sendMessage').length, 0);
  assert.equal(entry.roomId, null);
});

// ------------------------------------------------------ Telegram offset on restart

test('a restart does not process the last Telegram update again', async () => {
  const seen = [];
  const handler = async () => { seen.push(1); };
  const update = { update_id: 77, message: { chat: { id: 1 }, text: 'hello' } };

  let telegram = loadTelegram();
  mock.queueUpdates([update]);
  await telegram.pollUpdates(handler);
  assert.equal(seen.length, 1);
  assert.match(fs.readFileSync(`${mappingFile}.tgoffset`, 'utf8'), /^[0-9a-f]{8}:77$/);

  // "Restart": fresh module state, Telegram redelivers the unacknowledged update.
  telegram = loadTelegram();
  mock.queueUpdates([update, { update_id: 78, message: { chat: { id: 1 }, text: 'next' } }]);
  await telegram.pollUpdates(handler);
  assert.equal(seen.length, 2, 'only the new update 78 was handled');
});

test('an offset saved for another bot token is ignored', async () => {
  fs.writeFileSync(`${mappingFile}.tgoffset`, 'deadbeef:99999');
  const seen = [];
  const telegram = loadTelegram();
  mock.queueUpdates([{ update_id: 5, message: { chat: { id: 1 }, text: 'x' } }]);
  await telegram.pollUpdates(async () => { seen.push(1); });
  assert.equal(seen.length, 1);
});
