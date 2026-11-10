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

const {
  buildTelegramMessages,
  isWellFormedTelegramHtml,
  rcMarkdownToTelegramHtml,
} = require('../textFormat');

function render(text) {
  return buildTelegramMessages(text, { markdown: true }).map(({ text: out, parseMode }) => [parseMode, out]);
}

test('renders Rocket.Chat composer output (double markers) as Telegram HTML', () => {
  assert.deepEqual(render('**đậm**'), [['HTML', '<b>đậm</b>']]);
  assert.deepEqual(render('__nghiêng__'), [['HTML', '<i>nghiêng</i>']]);
  assert.deepEqual(render('~~gạch~~'), [['HTML', '<s>gạch</s>']]);
});

test('renders single-marker Rocket.Chat syntax and mixed text', () => {
  assert.deepEqual(render('*b* _i_ ~s~'), [['HTML', '<b>b</b> <i>i</i> <s>s</s>']]);
  assert.deepEqual(render('Xin chào **Việt Nam** _đẹp_'), [['HTML', 'Xin chào <b>Việt Nam</b> <i>đẹp</i>']]);
  assert.deepEqual(render('**bold _it_**'), [['HTML', '<b>bold <i>it</i></b>']]);
  assert.deepEqual(render('***both***'), [['HTML', '<b><i>both</i></b>']]);
});

test('renders inline code and fenced code blocks with HTML escaping', () => {
  assert.deepEqual(render('`a<b>&c`'), [['HTML', '<code>a&lt;b&gt;&amp;c</code>']]);
  assert.deepEqual(render('```\nplain <x>\n```'), [['HTML', '<pre>plain &lt;x&gt;</pre>']]);
  assert.deepEqual(
    render('```js\nconst a = 1 < 2;\n```'),
    [['HTML', '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>']]
  );
  assert.deepEqual(render('```one line```'), [['HTML', '<pre>one line</pre>']]);
});

test('never formats inside code spans or code blocks', () => {
  assert.deepEqual(render('`**x** _y_ ~z~`'), [['HTML', '<code>**x** _y_ ~z~</code>']]);
  assert.deepEqual(render('```\n**x**\n```'), [['HTML', '<pre>**x**</pre>']]);
});

test('does not mangle identifiers, math, tildes or URLs', () => {
  for (const text of [
    'snake_case_name and file_name_v2.pdf',
    '2 * 3 * 4 = 24',
    'khoảng ~100 và ~200',
    'https://example.com/a_b_c/d_',
    'a < b && c > d',
    '**',
    '```unclosed',
  ]) {
    assert.deepEqual(render(text), [[undefined, text]], text);
  }
});

test('renders safe links only', () => {
  assert.deepEqual(
    render('[Docs](https://example.com/a?x=1&y=2)'),
    [['HTML', '<a href="https://example.com/a?x=1&amp;y=2">Docs</a>']]
  );
  assert.deepEqual(
    render('[x](javascript:alert(1))'),
    [[undefined, '[x](javascript:alert(1))']]
  );
});

test('degrades instead of emitting invalid nesting', () => {
  // Improper nesting and code-inside-bold are not valid Telegram entities.
  assert.deepEqual(render('*a _b* c_'), [[undefined, '*a _b* c_']]);
  assert.deepEqual(render('**`x`**'), [['HTML', '**<code>x</code>**']]);
  assert.equal(isWellFormedTelegramHtml('<b><i>x</b></i>'), false);
  assert.equal(isWellFormedTelegramHtml('<b><code>x</code></b>'), false);
  assert.equal(isWellFormedTelegramHtml('<pre><code class="language-js">x</code></pre>'), true);
});

test('keeps plain mode verbatim and still resolves shortcodes', () => {
  assert.deepEqual(
    buildTelegramMessages('**not bold** :smile:').map(({ text: out, parseMode }) => [parseMode, out]),
    [[undefined, '**not bold** 😄']]
  );
  assert.deepEqual(render(':thumbsup: **ok**'), [['HTML', '👍 <b>ok</b>']]);
});

test('splits long formatted text without breaking code fences', () => {
  const code = `\`\`\`python\n${Array.from({ length: 600 }, (_, i) => `print("line ${i} <x>")`).join('\n')}\n\`\`\``;
  const messages = buildTelegramMessages(`Intro **bold**\n${code}\n_outro_`, { markdown: true });

  assert.ok(messages.length > 1);
  for (const message of messages) {
    assert.ok(message.source.length <= 4096);
    assert.equal(message.parseMode, 'HTML');
    assert.equal(isWellFormedTelegramHtml(message.text), true);
    assert.equal((message.source.match(/```/g) || []).length % 2, 0);
  }
  assert.equal(messages[0].text.startsWith('Intro <b>bold</b>'), true);
  assert.equal(messages.at(-1).text.endsWith('<i>outro</i>'), true);
});

test('rcMarkdownToTelegramHtml drops stash markers present in user input', () => {
  assert.equal(rcMarkdownToTelegramHtml('a\uE0000\uE001b'), 'a0b');
});
