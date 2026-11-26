const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the developer's real .env and mapping.json.
const mappingFile = path.join(os.tmpdir(), `p1-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'true';
process.env.AI_API_KEY = 'test-key';
process.env.ROCKETCHAT_URL = 'http://rocketchat.test';
process.env.ROCKETCHAT_AUTH_TOKEN = 'test-token';
process.env.ROCKETCHAT_USER_ID = 'test-user';
process.env.FB_PAGE_ACCESS_TOKEN = 'test-page-token';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';

const mapping = require('../src/core/mapping');
const rocketchat = require('../src/rocketchat/rocketchat');
const facebook = require('../src/platforms/facebook');
const telegram = require('../src/platforms/telegram');
const ai = require('../src/knowledge/ai');
const { MESSAGES } = require('../src/constants/messages');
const { classifyDeliveryError } = require('../src/core/deliveryErrors');
const { rcMarkdownToPlainText, splitByUtf16 } = require('../src/core/textFormat');
const { ENV } = require('../src/constants/config');
const { forwardToRocketChat, isAiPaused } = require('..');

test.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* already gone */ } });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------- G3 stickers

test('a sticker delivered as image + sticker becomes a single image attachment', () => {
  const url = 'https://scontent.xx.fbcdn.net/s.webp';
  const result = facebook.normalizeAttachments([
    { type: 'image', payload: { url, sticker_id: 1 } },
    { type: 'sticker', payload: { url, sticker_id: 1 } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'image');
});

test('a lone sticker is handled as an image; other attachments are untouched', () => {
  const result = facebook.normalizeAttachments([
    { type: 'sticker', payload: { url: 'https://x.fbcdn.net/a.png', sticker_id: 9 } },
    { type: 'file', payload: { url: 'https://cdn.fbsbx.com/f.pdf' } },
    { type: 'image', payload: { url: 'https://x.fbcdn.net/other.jpg' } },
  ]);
  assert.deepEqual(result.map((item) => item.type), ['image', 'file', 'image']);
});

test('handleWebhook reports a duplicated sticker once', async () => {
  const url = 'https://scontent.xx.fbcdn.net/s.webp';
  const seen = [];
  await facebook.handleWebhook({
    object: 'page',
    entry: [{ messaging: [{
      sender: { id: 'u' },
      message: { mid: 'm1', attachments: [
        { type: 'image', payload: { url, sticker_id: 5 } },
        { type: 'sticker', payload: { url, sticker_id: 5 } },
      ] },
    }] }],
  }, async () => {}, async (psid, attachment, meta) => seen.push([attachment.type, meta.key]));
  assert.deepEqual(seen, [['image', 'm1:0']]);
});

// ------------------------------------------------- G4 plain text and splitting

test('Markdown becomes readable plain text without losing identifiers or math', () => {
  const plain = rcMarkdownToPlainText('*đậm* _nghiêng_ ~gạch~ `code_x` snake_case_name 2 * 3 * 4 [liên kết](https://example.com/a_b)');
  assert.equal(plain, 'đậm nghiêng gạch code_x snake_case_name 2 * 3 * 4 liên kết (https://example.com/a_b)');
});

test('code blocks keep their content, bare URLs and escaped characters survive', () => {
  assert.equal(rcMarkdownToPlainText('```js\nif (a < b && c > d) {}\n```'), 'if (a < b && c > d) {}');
  assert.equal(rcMarkdownToPlainText('xem https://example.com/a_b_c ok'), 'xem https://example.com/a_b_c ok');
  assert.equal(rcMarkdownToPlainText('<b>không phải thẻ</b> & "quote"'), '<b>không phải thẻ</b> & "quote"');
});

test('timestamps and shortcodes become readable text', () => {
  const plain = rcMarkdownToPlainText('hẹn <t:2026-11-10T13:07:38.825+00:00:t> :tada:', { timeOptions: { timeZone: 'UTC' } });
  assert.match(plain, /^hẹn 13:07 🎉$/);
});

test('splitByUtf16 keeps every part within the limit, counting emoji as two units', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Dòng ${i}: nội dung kiểm thử 😀 ${'x'.repeat(40)}`).join('\n');
  const parts = splitByUtf16(text, 500);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 500, `part of ${part.length} units`);
  assert.equal(parts.join('\n').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('splitByUtf16 prefers line breaks over cutting a line in the middle', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `Dòng số ${i} có độ dài vừa phải để thử nghiệm`);
  const parts = splitByUtf16(lines.join('\n'), 300);
  for (const part of parts) {
    for (const line of part.split('\n')) assert.ok(lines.includes(line), `cut inside a line: "${line}"`);
  }
});

test('splitByUtf16 never splits a joined emoji and emits an oversized grapheme alone', () => {
  const family = '👨‍👩‍👧';
  const parts = splitByUtf16(family.repeat(20), 9);
  assert.ok(parts.every((part) => [...part].join('').length === part.length));
  assert.equal(parts.join(''), family.repeat(20));
});

test('Facebook sendMessage splits text longer than 2000 characters into ordered parts', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body).message.text);
    return json({ message_id: 'm' });
  };
  const text = Array.from({ length: 80 }, (_, i) => `Đoạn ${i}: ${'nội dung '.repeat(8)}`).join('\n');
  await facebook.sendMessage('u1', text);
  assert.ok(sent.length >= 2);
  for (const part of sent) assert.ok(part.length <= 2000);
  assert.ok(sent[0].startsWith('Đoạn 0:'));
  assert.ok(sent[sent.length - 1].includes('Đoạn 79:'));
});

test('sendAgentMessage strips Markdown before sending and skips empty text', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body).message.text);
    return json({ message_id: 'm' });
  };
  await facebook.sendAgentMessage('u1', '*xin chào* `a_b`', { timeZone: 'UTC' });
  await facebook.sendAgentMessage('u1', '   ');
  assert.deepEqual(sent, ['xin chào a_b']);
});

// ------------------------------------------------ G7 delivery error classes

test('Facebook delivery errors are classified', () => {
  const kind = (error) => classifyDeliveryError('facebook', error).kind;
  assert.equal(kind({ status: 400, code: 190 }), 'auth');
  assert.equal(kind({ status: 400, code: 10 }), 'permanent');
  assert.equal(kind({ status: 400, code: 100, subcode: 2018278 }), 'permanent');
  assert.equal(kind({ status: 400, code: 551 }), 'permanent');
  assert.equal(kind({ status: 400, code: 100 }), 'permanent');
  assert.equal(kind({ status: 400, code: 4 }), 'transient');
  assert.equal(kind({ status: 500, code: 2 }), 'transient');
  assert.equal(kind({ status: 429 }), 'transient');
  assert.equal(kind(new Error('fetch failed')), 'transient');
  assert.match(classifyDeliveryError('facebook', { code: 10 }).reason, /24 giờ/);
});

test('Telegram delivery errors are classified', () => {
  const kind = (error) => classifyDeliveryError('telegram', error).kind;
  assert.equal(kind({ status: 403, description: 'Forbidden: bot was blocked by the user' }), 'permanent');
  assert.equal(kind({ status: 400, description: 'Bad Request: chat not found' }), 'permanent');
  assert.equal(kind({ status: 400, description: 'Bad Request: wrong file identifier' }), 'permanent');
  assert.equal(kind({ status: 401 }), 'auth');
  assert.equal(kind({ status: 429 }), 'transient');
  assert.equal(kind({ status: 502 }), 'transient');
  assert.equal(kind(new TypeError('network')), 'transient');
});

test('Graph errors carry status, code and subcode for classification', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => json({ error: { code: 10, error_subcode: 2018278, message: 'x' } }, 400);
  await assert.rejects(facebook.sendMessage('u1', 'hi'), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 10);
    assert.equal(error.subcode, 2018278);
    return true;
  });
});

// ------------------------------------------------------ G6 closed room recovery

function seedEntry(platformUserId, roomId) {
  mapping.load();
  const entry = mapping.getOrCreate('facebook', platformUserId);
  mapping.update(entry, {
    visitorToken: `visitor_${platformUserId}`,
    roomId,
    lastMessageTimestamp: 999,
    processedMessageIds: ['a', 'b'],
    aiHandoffAt: 5,
    agentActiveAt: 6,
  });
  return entry;
}

test('a message to a closed room continues in the new room and resets room state', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const entry = seedEntry('closed-1', 'old-room');
  const posted = [];
  let roomLookups = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/api/v1/livechat/message')) {
      const body = JSON.parse(options.body);
      posted.push(body.rid);
      return body.rid === 'old-room' ? json({ success: false, error: 'room-closed' }, 400) : json({ success: true });
    }
    if (target.includes('/api/v1/livechat/room?token=')) {
      roomLookups += 1;
      return json({ room: { _id: 'new-room' } });
    }
    throw new Error(`unexpected request ${target}`);
  };

  await rocketchat.sendMessageToRocketChat('visitor_closed-1', 'old-room', 'xin chào');
  assert.deepEqual(posted, ['old-room', 'new-room']);
  assert.equal(entry.roomId, 'new-room');
  assert.equal(entry.lastMessageTimestamp, 0);
  assert.deepEqual(entry.processedMessageIds, []);
  assert.equal(entry.aiHandoffAt, 0);
  assert.equal(entry.agentActiveAt, 0);

  // A second message that still carries the stale id must reuse the new room.
  await rocketchat.sendMessageToRocketChat('visitor_closed-1', 'old-room', 'tin tiếp');
  assert.equal(roomLookups, 1, 'the room is looked up once, not per message');
  assert.deepEqual(posted.slice(-1), ['new-room']);
});

test('a refused message with another error is not treated as a closed room', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  seedEntry('other-1', 'room-x');
  global.fetch = async (url) => (String(url).endsWith('/api/v1/livechat/message')
    ? json({ success: false, error: 'invalid-token' }, 400)
    : json({ room: { _id: 'room-x' } }));
  await assert.rejects(rocketchat.sendMessageToRocketChat('visitor_other-1', 'room-x', 'hi'), /invalid-token/);
});

test('an upload refused with 403 unauthorized recovers when the room moved on', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const entry = seedEntry('closed-2', 'old-room');
  const uploads = [];
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/api/v1/livechat/upload/')) {
      const rid = target.split('/').pop();
      uploads.push(rid);
      return rid === 'old-room' ? json({ success: false, error: 'unauthorized' }, 403) : json({ _id: 'file-1' });
    }
    if (target.includes('/api/v1/livechat/room?token=')) return json({ room: { _id: 'new-room' } });
    throw new Error(`unexpected request ${target}`);
  };
  await rocketchat.uploadLivechatFile('visitor_closed-2', 'old-room', {
    filename: 'a.txt', buffer: Buffer.from('abc'), mimeType: 'text/plain',
  });
  assert.deepEqual(uploads, ['old-room', 'new-room']);
  assert.equal(entry.roomId, 'new-room');
});

test('a genuine upload 403 (same room still open) is rethrown', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  seedEntry('auth-1', 'room-y');
  global.fetch = async (url) => (String(url).includes('/upload/')
    ? json({ success: false, error: 'unauthorized' }, 403)
    : json({ room: { _id: 'room-y' } }));
  await assert.rejects(
    rocketchat.uploadLivechatFile('visitor_auth-1', 'room-y', { filename: 'a.txt', buffer: Buffer.from('abc') }),
    /unauthorized/
  );
});

test('pollNewAgentMessages flags a room closed by the agent', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => json({ messages: [
    { _id: '1', msg: 'chào bạn', ts: '2026-11-24T05:00:00.000Z', u: { _id: 'agent' } },
    { _id: '2', t: 'livechat-close', msg: 'Closed', ts: '2026-11-24T05:01:00.000Z' },
  ] });
  const messages = await rocketchat.pollNewAgentMessages('room', 'visitor_x', 0, []);
  assert.equal(messages.length, 1);
  assert.equal(messages.closed, true);
});

// ------------------------------------------------------- G5 AI pause + G8 edits

function stubConversation(t) {
  const saved = {
    askAI: ai.askAI,
    sendMessage: facebook.sendMessage,
    getOrCreateVisitor: rocketchat.getOrCreateVisitor,
    getOrCreateRoom: rocketchat.getOrCreateRoom,
    sendMessageToRocketChat: rocketchat.sendMessageToRocketChat,
  };
  t.after(() => {
    ai.askAI = saved.askAI;
    facebook.sendMessage = saved.sendMessage;
    rocketchat.getOrCreateVisitor = saved.getOrCreateVisitor;
    rocketchat.getOrCreateRoom = saved.getOrCreateRoom;
    rocketchat.sendMessageToRocketChat = saved.sendMessageToRocketChat;
  });
  const state = { aiCalls: 0, toCustomer: [], toRoom: [], decision: { handled: false } };
  ai.askAI = async () => { state.aiCalls += 1; return state.decision; };
  facebook.sendMessage = async (psid, text) => { state.toCustomer.push(text); };
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room-1';
  rocketchat.sendMessageToRocketChat = async (token, rid, text) => { state.toRoom.push(text); return { success: true }; };
  mapping.load();
  return state;
}

test('the AI hands off once, then stays quiet while a human owns the conversation', async (t) => {
  const state = stubConversation(t);
  const send = (text, options) => forwardToRocketChat('facebook', 'ai-1', 'FB ai-1', text, options);

  await send('khiếu nại hoàn tiền');
  assert.equal(state.aiCalls, 1);
  assert.equal(state.toCustomer.length, 1, 'one handoff notice');
  assert.ok(isAiPaused(mapping.findByPlatformUser('facebook', 'ai-1')));

  await send('có ai ở đó không?');
  await send('alo?');
  assert.equal(state.aiCalls, 1, 'the AI is not asked again');
  assert.equal(state.toCustomer.length, 1, 'no repeated handoff notice');
  assert.equal(state.toRoom.filter((text) => text === 'có ai ở đó không?' || text === 'alo?').length, 2, 'messages still reach the agent');
});

test('an agent reply silences the AI, and the pause expires', async (t) => {
  const state = stubConversation(t);
  const send = (text) => forwardToRocketChat('facebook', 'ai-2', 'FB ai-2', text);
  state.decision = { handled: true, reply: 'Xin chào!' };

  await send('hi');
  assert.equal(state.aiCalls, 1);
  assert.deepEqual(state.toCustomer, ['Xin chào!']);

  const entry = mapping.findByPlatformUser('facebook', 'ai-2');
  mapping.update(entry, { agentActiveAt: Date.now() });
  await send('còn nữa');
  assert.equal(state.aiCalls, 1, 'agent is active: no AI call');

  mapping.update(entry, { agentActiveAt: Date.now() - ENV.aiResumeAfterMs - 1000 });
  await send('quay lại');
  assert.equal(state.aiCalls, 2, 'pause expired: the AI answers again');
});

test('/bot gives the conversation back to the AI', async (t) => {
  const state = stubConversation(t);
  const send = (text) => forwardToRocketChat('facebook', 'ai-3', 'FB ai-3', text);

  await send('khiếu nại');
  assert.ok(isAiPaused(mapping.findByPlatformUser('facebook', 'ai-3')));

  state.toCustomer.length = 0;
  await send('/bot');
  assert.deepEqual(state.toCustomer, [MESSAGES.ai.resumed]);
  assert.equal(isAiPaused(mapping.findByPlatformUser('facebook', 'ai-3')), false);
  assert.equal(state.aiCalls, 1, '/bot itself is not sent to the AI');
});

test('an AI failure still hands off but does not pause the AI', async (t) => {
  const state = stubConversation(t);
  ai.askAI = async () => { throw new Error('timeout'); };
  await forwardToRocketChat('facebook', 'ai-4', 'FB ai-4', 'xin chào');
  assert.equal(state.toCustomer.length, 1, 'customer is told a human will answer');
  assert.equal(isAiPaused(mapping.findByPlatformUser('facebook', 'ai-4')), false);
});

test('an edited message reaches the agent marked as edited, without AI or a reply', async (t) => {
  const state = stubConversation(t);
  await forwardToRocketChat('facebook', 'ed-1', 'FB ed-1', 'nội dung mới', { edited: true });
  assert.equal(state.aiCalls, 0);
  assert.deepEqual(state.toCustomer, []);
  assert.deepEqual(state.toRoom, [MESSAGES.bridge.editedForRoom('nội dung mới')]);
});

test('Telegram flags edited text and ignores edits of media', async () => {
  const calls = [];
  const onMessage = async (chatId, text, meta) => calls.push([chatId, text, meta.edited]);
  const document = async () => calls.push('document');
  const media = async () => calls.push('media');

  await telegram.handleWebhook({ message: { chat: { id: 1 }, text: 'gốc' } }, onMessage, document, null, media);
  await telegram.handleWebhook({ edited_message: { chat: { id: 1 }, text: 'sửa' } }, onMessage, document, null, media);
  await telegram.handleWebhook({ edited_message: { chat: { id: 1 }, photo: [{ file_id: 'x' }], caption: 'c' } }, onMessage, document, null, media);

  assert.deepEqual(calls, [[1, 'gốc', false], [1, 'sửa', true]]);
});
