const test = require('node:test');
const assert = require('node:assert/strict');

const { rcToTelegramText, telegramToRcText } = require('../textFormat');

test('converts known shortcodes and preserves unknown shortcodes', () => {
  assert.deepEqual(rcToTelegramText(':smile: :thumbsup: :not-real:'), ['😄 👍 :not-real:']);
});

test('does not convert shortcodes inside inline or fenced code', () => {
  assert.deepEqual(
    rcToTelegramText(':smile: `:smile:`\n```\n:thumbsup:\n```'),
    [':smile: `:smile:`\n```\n:thumbsup:\n```'].map((value) => value.replace(':smile:', '😄'))
  );
});

test('splits long text at safe boundaries and preserves joined emoji', () => {
  const chunks = rcToTelegramText('a'.repeat(9000));
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join('').length, 9000);

  const emoji = '👨‍👩‍👧'.repeat(1000);
  for (const chunk of rcToTelegramText(emoji)) {
    assert.equal(chunk.includes('\u200d'), true);
  }
  assert.equal(rcToTelegramText(emoji).join(''), emoji);
});

test('normalizes Telegram text to NFC without escaping it', () => {
  assert.equal(telegramToRcText('e\u0301 😀'), 'é 😀');
});
