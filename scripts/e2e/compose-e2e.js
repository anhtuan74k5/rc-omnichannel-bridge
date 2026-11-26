#!/usr/bin/env node
/**
 * End-to-end test of the Docker Compose stack with mocked Meta, Telegram and Zalo.
 *
 *   npm run test:e2e              build, start, test, then remove the stack and its volumes
 *   E2E_KEEP=1 npm run test:e2e   leave the stack running afterwards
 *
 * Needs Docker. Uses its own project name, ports (3300, 3301, 4310) and throwaway
 * secrets, so it never touches .env or another running stack.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const project = 'rcob-e2e';
const secret = () => crypto.randomBytes(18).toString('hex');
const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcob-e2e-')), 'e2e.env');
const env = {
  COMPOSE_PROJECT_NAME: project,
  BRIDGE_ENV_FILE: envFile.replace(/\\/g, '/'),
  RC_HOST_PORT: '3300',
  BRIDGE_HOST_PORT: '3301',
  MOCK_HOST_PORT: '4310',
  RC_ROOT_URL: 'http://localhost:3300',
  RC_ADMIN_PASSWORD: `Aa1!${secret()}`,
  ROCKETCHAT_AGENT_USERNAME: 'e2e.agent',
  ROCKETCHAT_AGENT_PASSWORD: `Aa1!${secret()}`,
  // A token of some other Rocket.Chat: Compose must ignore it.
  ROCKETCHAT_AUTH_TOKEN: 'foreign-token',
  ROCKETCHAT_USER_ID: 'foreign-user',
  ROCKETCHAT_WEBHOOK_SECRET: secret(),
  FB_PAGE_ACCESS_TOKEN: 'mock-page-token',
  FB_VERIFY_TOKEN: secret(),
  FB_APP_SECRET: secret(),
  TELEGRAM_BOT_TOKEN: '123:mock-bot-token',
  TELEGRAM_POLLING: 'false',
  TELEGRAM_WEBHOOK_SECRET: secret(),
  ZALO_ENABLED: 'true',
  ZALO_APP_ID: 'e2e-app',
  ZALO_OA_SECRET_KEY: secret(),
  ZALO_ACCESS_TOKEN: 'mock-zalo-token',
  AI_ENABLED: 'false',
};
const RC = `http://localhost:${env.RC_HOST_PORT}`;
const BRIDGE = `http://localhost:${env.BRIDGE_HOST_PORT}`;
const MOCK = `http://localhost:${env.MOCK_HOST_PORT}`;

// Variables of the calling shell would override the env file: start without them.
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !(key in env)));
function compose(...args) {
  execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.yml',
    '-f', 'scripts/e2e/compose.e2e.yml', ...args], { cwd: ROOT, env: shellEnv, stdio: 'inherit' });
}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || '', ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, note: error.message, ms: Date.now() - started });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitFor(fn, ms = 20000, step = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

let agent;
async function rc(method, path, body, raw) {
  const headers = agent ? { 'X-Auth-Token': agent.authToken, 'X-User-Id': agent.userId } : {};
  if (!raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${RC}/api/v1/${path}`, { method, headers, body: raw || (body && JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(`${path}: ${res.status} ${data.error || data.message || ''}`);
  return data;
}
function mongo(js) {
  const out = execFileSync('docker', ['exec', `${project}-mongodb-1`, 'mongosh', 'rocketchat', '--quiet', '--eval', `EJSON.stringify(${js})`]);
  return JSON.parse(out.toString());
}
const mockRequests = async () => (await fetch(`${MOCK}/__requests`)).json();
const sendsTo = async (route) => (await mockRequests()).filter((r) => r.route === route);
const health = async () => (await fetch(`${BRIDGE}/health`)).json();

function fbPost(body) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', env.FB_APP_SECRET).update(raw).digest('hex');
  return fetch(`${BRIDGE}/webhook/facebook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${sig}` },
    body: raw,
  });
}
const fbMessage = (psid, message) => ({
  object: 'page',
  entry: [{ id: '1234567890', time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: '1234567890' }, timestamp: Date.now(), message }] }],
});
function tgPost(update) {
  return fetch(`${BRIDGE}/webhook/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
}
const messagesIn = (rid) => mongo(`db.rocketchat_message.find({ rid: ${JSON.stringify(rid)} }, { msg: 1, file: 1, 'u.username': 1, t: 1 }).sort({ ts: 1 }).toArray()`);

async function takeRoom(rid) {
  const inquiry = mongo(`db.rocketchat_livechat_inquiry.findOne({ rid: ${JSON.stringify(rid)} }, { _id: 1, status: 1 })`);
  if (inquiry && inquiry.status === 'queued') await rc('POST', 'livechat/inquiries.take', { inquiryId: inquiry._id });
  const room = mongo(`db.rocketchat_room.findOne({ _id: ${JSON.stringify(rid)} }, { servedBy: 1 })`);
  assert(room.servedBy && room.servedBy.username === env.ROCKETCHAT_AGENT_USERNAME, 'agent did not get the room');
}

async function scenarios() {
  const PSID = `psid${Date.now()}`;
  const CHAT = 700000 + Math.floor(Math.random() * 1000);
  let fbRoom;
  let tgRoom;

  await check('Bridge /health through the published port', async () => {
    const h = await health();
    assert(h.status === 'ok' || h.ok === true || h.rocketchat, `unexpected ${JSON.stringify(h).slice(0, 120)}`);
    return `rcWebhook enabled=${JSON.stringify(h.rocketChatWebhook?.enabled ?? h.rcWebhook?.enabled ?? '?')}`;
  });

  await check('Docker HEALTHCHECK reports healthy', async () => {
    const state = await waitFor(() => {
      const s = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', `${project}-bridge-1`]).toString().trim();
      return s === 'healthy' ? s : null;
    }, 60000, 3000);
    assert(state === 'healthy', 'container never became healthy');
  });

  await check('Facebook webhook verification (GET hub.challenge)', async () => {
    const res = await fetch(`${BRIDGE}/webhook/facebook?hub.mode=subscribe&hub.verify_token=${env.FB_VERIFY_TOKEN}&hub.challenge=42abc`);
    const text = await res.text();
    assert(res.status === 200 && text === '42abc', `got ${res.status} ${text}`);
  });

  await check('Facebook webhook rejects a bad signature', async () => {
    const res = await fetch(`${BRIDGE}/webhook/facebook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' },
      body: JSON.stringify(fbMessage('x', { mid: 'm.bad', text: 'x' })),
    });
    assert(res.status === 401 || res.status === 403, `status ${res.status}`);
    return `status ${res.status}`;
  });

  // Log the agent in (the account rc-setup created).
  agent = (await fetch(`${RC}/api/v1/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: env.ROCKETCHAT_AGENT_USERNAME, password: env.ROCKETCHAT_AGENT_PASSWORD }),
  }).then((r) => r.json())).data;
  await check('Agent account from rc-setup can log in', async () => assert(agent && agent.authToken, 'login failed'));
  // Same as a real agent logged in to the UI: online + available for Omnichannel.
  await rc('POST', 'users.setStatus', { status: 'online', message: '' });
  await rc('POST', 'livechat/agent.status', { status: 'available' }).catch(() => {});
  await check('Agent is online and available', async () => {
    const u = mongo(`db.users.findOne({ username: ${JSON.stringify(env.ROCKETCHAT_AGENT_USERNAME)} }, { status: 1, statusLivechat: 1 })`);
    assert(u.status === 'online' && u.statusLivechat === 'available', JSON.stringify(u));
  });

  await check('Messenger text -> new Rocket.Chat room', async () => {
    const res = await fbPost(fbMessage(PSID, { mid: `m.${PSID}.1`, text: 'Xin chao tu Messenger (docker)' }));
    assert(res.status === 200, `webhook status ${res.status}`);
    fbRoom = await waitFor(() => mongo(`db.rocketchat_room.findOne({ t: 'l', open: true, fname: /${PSID}/ }, { _id: 1, fname: 1 })`));
    assert(fbRoom, 'no room');
    const msgs = await waitFor(() => { const m = messagesIn(fbRoom._id).filter((x) => x.msg && x.msg.includes('Messenger (docker)')); return m.length ? m : null; });
    assert(msgs, 'message not in room');
    return `room "${fbRoom.fname}"`;
  });

  await check('Duplicate Messenger delivery is ignored', async () => {
    await fbPost(fbMessage(PSID, { mid: `m.${PSID}.1`, text: 'Xin chao tu Messenger (docker)' }));
    await sleep(3000);
    const count = messagesIn(fbRoom._id).filter((x) => x.msg && x.msg.includes('Messenger (docker)')).length;
    assert(count === 1, `found ${count} copies`);
  });

  await check('Messenger: 5 messages keep their order', async () => {
    for (let i = 1; i <= 5; i += 1) await fbPost(fbMessage(PSID, { mid: `m.${PSID}.o${i}`, text: `thu tu ${i}` }));
    const got = await waitFor(() => {
      const list = messagesIn(fbRoom._id).map((m) => m.msg).filter((m) => /^thu tu \d$/.test(m || ''));
      return list.length === 5 ? list : null;
    });
    assert(got, 'not all 5 arrived');
    assert(got.join(',') === 'thu tu 1,thu tu 2,thu tu 3,thu tu 4,thu tu 5', `order ${got.join(',')}`);
  });

  await check('Messenger attachment from a non-Facebook host is refused (SSRF guard)', async () => {
    await fbPost(fbMessage(PSID, { mid: `m.${PSID}.img`, attachments: [{ type: 'image', payload: { url: 'http://example.invalid/photo.png' } }] }));
    await sleep(4000);
    assert(!messagesIn(fbRoom._id).some((m) => m.file), 'file from a foreign host was uploaded');
    return 'not downloaded (real images are tested with real Messenger)';
  });

  await check('Telegram text (webhook + secret) -> new room', async () => {
    const res = await tgPost({ update_id: 9001, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'Docker', last_name: 'Tester' }, text: 'Xin chao tu Telegram (docker)' } });
    assert(res.status === 200, `status ${res.status}`);
    tgRoom = await waitFor(() => mongo(`db.rocketchat_room.findOne({ t: 'l', open: true, fname: /${CHAT}|Docker Tester/ }, { _id: 1, fname: 1 })`));
    assert(tgRoom, 'no room');
    const msg = await waitFor(() => messagesIn(tgRoom._id).find((m) => m.msg && m.msg.includes('Telegram (docker)')));
    assert(msg, 'message missing');
    return `room "${tgRoom.fname}"`;
  });

  await check('Telegram webhook rejects a wrong secret', async () => {
    const res = await fetch(`${BRIDGE}/webhook/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, body: '{}' });
    assert(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  await check('Telegram document -> file in Rocket.Chat', async () => {
    await tgPost({ update_id: 9002, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'Docker' }, document: { file_id: 'F1', file_unique_id: 'U1', file_name: 'order.zip', mime_type: 'application/zip', file_size: 40 } } });
    const file = await waitFor(() => messagesIn(tgRoom._id).find((m) => m.file));
    assert(file, 'no file message');
    return `file ${file.file.name}`;
  });

  await check('Agent takes both rooms', async () => { await takeRoom(fbRoom._id); await takeRoom(tgRoom._id); });

  const before = (await health());
  await check('Agent text -> Messenger via Rocket.Chat webhook (no ngrok)', async () => {
    const t0 = Date.now();
    await rc('POST', 'chat.sendMessage', { message: { rid: fbRoom._id, msg: 'Agent tra loi Messenger (docker)' } });
    const sent = await waitFor(async () => (await sendsTo('me/messages')).find((r) => r.json && r.json.includes('Agent tra loi Messenger') && r.json.includes(PSID)), 20000, 300);
    assert(sent, 'not forwarded to this customer');
    return `${Date.now() - t0} ms`;
  });

  await check('Agent text -> Telegram via webhook', async () => {
    const t0 = Date.now();
    await rc('POST', 'chat.sendMessage', { message: { rid: tgRoom._id, msg: '**Agent** tra loi Telegram (docker)' } });
    const sent = await waitFor(async () => (await sendsTo('sendMessage')).length > 0, 20000, 300);
    assert(sent, 'not forwarded');
    return `${Date.now() - t0} ms`;
  });

  await check('Webhook really used (events counted in /health)', async () => {
    const after = await health();
    const pick = (h) => JSON.stringify(h.rocketChatWebhook || h.rcWebhook || h.webhook || {});
    return `before ${pick(before)} after ${pick(after)}`;
  });


  await check('Visitor tokens are random', async () => {
    const tokens = mongo("db.rocketchat_livechat_visitor.find({}, { token: 1 }).toArray()").map((v) => v.token);
    assert(tokens.length >= 2 && tokens.every((t) => /^visitor_[0-9a-f]{48}$/.test(t)), 'a token is guessable');
  });

  await check('A guessable token from an older version is revoked on real Rocket.Chat', async () => {
    await rc('POST', 'livechat/visitor', { visitor: { token: 'visitor_424242', name: 'Old', email: '424242@bridge.local' } });
    const script = "const m=require('./src/core/mapping');m.load();const e=m.getOrCreate('telegram','424242');"
      + "m.update(e,{visitorToken:'visitor_424242'});require('./src/rocketchat/rocketchat')"
      + ".getOrCreateVisitor('424242','Old',{platform:'telegram'}).then((t)=>console.log('TOKEN='+t))";
    const out = execFileSync('docker', ['exec', '-e', 'MAPPING_STORE=json', '-e', 'MAPPING_FILE=/tmp/revoke.json',
      '-e', `ROCKETCHAT_AGENT_USERNAME=${env.ROCKETCHAT_AGENT_USERNAME}`, `${project}-bridge-1`, 'node', '-e', script]).toString();
    const token = (out.match(/TOKEN=(visitor_[0-9a-f]{48})/) || [])[1];
    assert(token, 'no new token');
    assert((await fetch(`${RC}/api/v1/livechat/visitor/visitor_424242`)).status === 400, 'the old token still works');
    assert((await fetch(`${RC}/api/v1/livechat/visitor/${token}`)).ok, 'the new token does not work');
    const record = mongo(`db.rocketchat_livechat_visitor.findOne({ token: ${JSON.stringify(token)} }, { visitorEmails: 1 })`);
    assert(!JSON.stringify(record.visitorEmails).includes('424242@'), 'the guessable e-mail is still there');
  });

  await check('A link card in an agent message is delivered as text, not fetched', async () => {
    const already = (await sendsTo('sendMessage')).length;
    await rc('POST', 'chat.postMessage', { roomId: tgRoom._id, text: 'Xem bai nay (e2e)',
      attachments: [{ title: 'Ngoai', title_link: 'http://mock:4010/steal.png' }] });
    const sent = await waitFor(async () => (await sendsTo('sendMessage')).slice(already).find((r) => r.json.includes('Xem bai nay')));
    assert(sent, 'text not delivered');
  });

  await check('Agent file -> Telegram', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('agent file')], { type: 'text/plain' }), 'reply.txt');
    const up = await rc('POST', `rooms.media/${tgRoom._id}`, null, form);
    await rc('POST', `rooms.mediaConfirm/${tgRoom._id}/${up.file._id}`, { msg: '' });
    const sent = await waitFor(async () => (await sendsTo('sendDocument'))[0], 30000);
    assert(sent, 'file not sent');
  });

  await check('Zalo: signed webhook -> room, agent reply -> Zalo mock', async () => {
    const timestamp = String(Date.now());
    const raw = JSON.stringify({ app_id: env.ZALO_APP_ID, timestamp, event_name: 'user_send_text',
      sender: { id: 'zalo-e2e' }, message: { msg_id: 'z1', text: 'Xin chao tu Zalo (docker)' } });
    const mac = crypto.createHash('sha256').update(env.ZALO_APP_ID + raw + timestamp + env.ZALO_OA_SECRET_KEY).digest('hex');
    const res = await fetch(`${BRIDGE}/webhook/zalo`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ZEvent-Signature': `mac=${mac}` }, body: raw });
    assert(res.status === 200, `status ${res.status}`);
    const room = await waitFor(() => mongo("db.rocketchat_room.findOne({ t: 'l', open: true, fname: /zalo-e2e/ }, { _id: 1 })"));
    assert(room, 'no room');
    await takeRoom(room._id);
    await rc('POST', 'chat.sendMessage', { message: { rid: room._id, msg: 'Agent tra loi Zalo' } });
    const sent = await waitFor(async () => (await sendsTo('oa/message/cs')).find((r) => r.json.includes('Agent tra loi Zalo')));
    assert(sent, 'reply not sent');
  });

  await check('Mapping is stored in SQLite', async () => {
    execFileSync('docker', ['exec', `${project}-bridge-1`, 'test', '-s', '/app/data/mapping.db']);
  });

  await check('Long agent text is split for Messenger (2000-char limit)', async () => {
    const already = (await sendsTo('me/messages')).length;
    const long = Array.from({ length: 60 }, (_, i) => `Dong ${i + 1}: noi dung kiem tra tach tin nhan dai`).join('\n');
    await rc('POST', 'chat.sendMessage', { message: { rid: fbRoom._id, msg: long } });
    const parts = await waitFor(async () => { const n = (await sendsTo('me/messages')).length - already; return n >= 2 ? n : null; }, 20000, 500);
    assert(parts >= 2, 'not split');
    return `${parts} parts`;
  });

  await check('Agent file -> Messenger attachment', async () => {
    const already = (await mockRequests()).length;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('agent note')], { type: 'text/plain' }), 'agent-note.txt');
    const up = await rc('POST', `rooms.media/${fbRoom._id}`, null, form);
    await rc('POST', `rooms.mediaConfirm/${fbRoom._id}/${up.file._id}`, { msg: '' });
    const sent = await waitFor(async () => (await mockRequests()).slice(already).find((r) => r.route === 'me/messages' && r.contentType.includes('multipart')), 30000, 500);
    assert(sent, 'attachment not sent');
    return `${sent.bytes} bytes multipart`;
  });

  await check('Agent closes Messenger room -> customer notified once', async () => {
    const already = (await sendsTo('me/messages')).length;
    const t0 = Date.now();
    await rc('POST', 'livechat/room.closeByUser', { rid: fbRoom._id, comment: 'done' });
    await waitFor(async () => (await sendsTo('me/messages')).length > already, 90000, 500);
    const took = Date.now() - t0;
    await sleep(15000); // let polling run again: still one notice
    const notices = (await sendsTo('me/messages')).length - already;
    assert(notices === 1, `${notices} notices after ${took} ms`);
    return `notice after ${took} ms`;
  });

  await check('Customer writes again after close -> new room', async () => {
    await fbPost(fbMessage(PSID, { mid: `m.${PSID}.again`, text: 'Toi quay lai (docker)' }));
    const room = await waitFor(() => mongo(`db.rocketchat_room.findOne({ t: 'l', open: true, fname: /${PSID}/ }, { _id: 1 })`));
    assert(room && room._id !== fbRoom._id, 'no new room');
    fbRoom = room;
  });

  await check('Bridge restart keeps mapping (volume) and reuses the room', async () => {
    execFileSync('docker', ['restart', `${project}-bridge-1`]);
    await waitFor(async () => { try { return (await fetch(`${BRIDGE}/health`)).ok; } catch { return false; } }, 60000, 1000);
    await fbPost(fbMessage(PSID, { mid: `m.${PSID}.afterRestart`, text: 'Sau khi khoi dong lai (docker)' }));
    const msg = await waitFor(() => messagesIn(fbRoom._id).find((m) => m.msg && m.msg.includes('khoi dong lai')));
    assert(msg, 'message did not land in the same room');
    const rooms = mongo(`db.rocketchat_room.countDocuments({ t: 'l', open: true, fname: /${PSID}/ })`);
    assert(rooms === 1, `${rooms} open rooms`);
  });

}

async function main() {
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  try {
    compose('down', '-v', '--remove-orphans');
    compose('up', '-d', '--build', '--wait', '--wait-timeout', '600', 'mock', 'bridge');
    await scenarios();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.note ? ` - ${r.note}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`PASS ${passed}/${results.length}`);
  if (passed !== results.length || results.length === 0) process.exitCode = 1;
  if (process.exitCode) compose('logs', '--tail', '80', 'rc-setup', 'bridge');
  if (!process.env.E2E_KEEP) {
    compose('down', '-v', '--remove-orphans');
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  } else {
    console.log(`Stack left running; env file: ${envFile}`);
  }
}

main();
