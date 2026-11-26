const test = require('node:test');
const assert = require('node:assert/strict');

const { callsPerTick, createPollScheduler } = require('../src/rocketchat/pollScheduler');
const { createKeyedQueue } = require('../src/core/keyedQueue');

function entry(id, extra = {}) {
  return { platform: 'telegram', platformUserId: id, ...extra };
}

test('callsPerTick turns a per-minute budget into rooms per tick, never below one', () => {
  assert.equal(callsPerTick(8, 10000), 1);
  assert.equal(callsPerTick(60, 10000), 10);
  assert.equal(callsPerTick(30, 10000), 5);
  assert.equal(callsPerTick(1, 1000), 1);
});

test('scheduler never starves a room when the budget is one room per tick', () => {
  let time = 1_000_000;
  const scheduler = createPollScheduler({ now: () => time, hotWindowMs: 0 });
  const rooms = [entry('a'), entry('b'), entry('c'), entry('d')];
  const counts = new Map(rooms.map((room) => [room.platformUserId, 0]));

  for (let tick = 0; tick < 40; tick += 1) {
    const [picked] = scheduler.select(rooms, 1);
    scheduler.markPolled(picked);
    counts.set(picked.platformUserId, counts.get(picked.platformUserId) + 1);
    time += 10000;
  }

  for (const [id, count] of counts) assert.equal(count, 10, `room ${id} polled ${count} times`);
});

test('hot rooms are polled more often but quiet rooms are still served', () => {
  let time = 5_000_000;
  const scheduler = createPollScheduler({ now: () => time, hotWindowMs: 10 * 60 * 1000 });
  const hot = entry('hot', { lastInboundAt: time });
  const cold = entry('cold');
  const counts = { hot: 0, cold: 0 };
  let longestColdWaitTicks = 0;
  let coldWait = 0;

  for (let tick = 0; tick < 60; tick += 1) {
    hot.lastInboundAt = time; // customer keeps chatting in the hot room
    const [picked] = scheduler.select([hot, cold], 1);
    scheduler.markPolled(picked);
    counts[picked.platformUserId] += 1;
    if (picked === cold) coldWait = 0;
    else coldWait += 1;
    longestColdWaitTicks = Math.max(longestColdWaitTicks, coldWait);
    time += 10000;
  }

  assert.ok(counts.hot > counts.cold, `hot ${counts.hot} vs cold ${counts.cold}`);
  assert.ok(longestColdWaitTicks <= 3, `quiet room waited ${longestColdWaitTicks} ticks in a row`);
});

test('a room refused with 429 stays first in line for the next tick', () => {
  let time = 9_000_000;
  const scheduler = createPollScheduler({ now: () => time, hotWindowMs: 0 });
  const rooms = [entry('a'), entry('b')];

  const [first] = scheduler.select(rooms, 1);
  scheduler.markPolled(first);
  scheduler.release(first); // 429: not served
  time += 10000;

  const [second] = scheduler.select(rooms, 1);
  assert.equal(second.platformUserId, first.platformUserId);
});

test('an urgent room (closed by the agent) jumps the line once', () => {
  let time = 2_000_000;
  const scheduler = createPollScheduler({ now: () => time, hotWindowMs: 10 * 60 * 1000 });
  const rooms = Array.from({ length: 6 }, (_, i) => entry(`r${i}`, { lastInboundAt: time }));
  for (const room of rooms.slice(0, 5)) scheduler.markPolled(room); // r5 is the most overdue
  time += 10000;
  scheduler.markPolled(rooms[2]); // r2 was just polled

  scheduler.prioritize(rooms[2]);
  const [first] = scheduler.select(rooms, 1);
  assert.equal(first.platformUserId, 'r2', 'urgent room is chosen even though it was just polled');
  scheduler.markPolled(first);
  time += 10000;

  const [next] = scheduler.select(rooms, 1);
  assert.notEqual(next.platformUserId, 'r2', 'urgency is used up after one poll');
});

test('an urgent room refused with 429 stays urgent', () => {
  const time = 3_000_000;
  const scheduler = createPollScheduler({ now: () => time, hotWindowMs: 0 });
  const rooms = [entry('a'), entry('b'), entry('c')];
  scheduler.markPolled(rooms[1]);
  scheduler.prioritize(rooms[1]);
  const [picked] = scheduler.select(rooms, 1);
  assert.equal(picked.platformUserId, 'b');
  scheduler.markPolled(picked);
  scheduler.release(picked);
  assert.equal(scheduler.select(rooms, 1)[0].platformUserId, 'b');
});

test('keyed queue keeps order per key and runs different keys in parallel', async () => {
  const queue = createKeyedQueue();
  const order = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const started = Date.now();
  queue.enqueue('u1', async () => { await delay(80); order.push('u1-first'); });
  queue.enqueue('u1', async () => { order.push('u1-second'); });
  queue.enqueue('u2', async () => { await delay(80); order.push('u2'); });

  assert.equal(await queue.idle(2000), true);
  assert.ok(Date.now() - started < 200, 'keys should not wait for each other');
  assert.deepEqual(order.filter((item) => item.startsWith('u1')), ['u1-first', 'u1-second']);
  assert.ok(order.includes('u2'));
  assert.equal(queue.size(), 0);
});

test('a failing task is reported and does not stall later tasks for the same key', async () => {
  const errors = [];
  const queue = createKeyedQueue({ onError: (error, key) => errors.push([key, error.message]) });
  const done = [];

  queue.enqueue('u1', async () => { throw new Error('boom'); });
  queue.enqueue('u1', async () => { done.push('after'); });

  assert.equal(await queue.idle(1000), true);
  assert.deepEqual(errors, [['u1', 'boom']]);
  assert.deepEqual(done, ['after']);
});

test('idle() reports false when work outlasts the timeout', async () => {
  const queue = createKeyedQueue();
  queue.enqueue('slow', () => new Promise((resolve) => setTimeout(resolve, 150)));
  assert.equal(await queue.idle(20), false);
  assert.equal(await queue.idle(1000), true);
});
