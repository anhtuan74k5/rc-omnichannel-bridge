const SHORTCODES = Object.freeze({
  smile: '😄',
  thumbsup: '👍',
  thumbsdown: '👎',
  heart: '❤️',
  laugh: '😂',
  sob: '😭',
  cry: '😢',
  wink: '😉',
  tada: '🎉',
  fire: '🔥',
});

function replaceShortcodes(text) {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, name) => SHORTCODES[name.toLowerCase()] || match);
}

function convertOutsideCode(text, converter) {
  const parts = String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((part, index) => (index % 2 === 0 ? converter(part) : part)).join('');
}

function segmentGraphemes(text) {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
      .map(({ segment }) => segment);
  }
  return Array.from(text);
}

function splitTelegramText(text, maxLength = 4096) {
  const graphemes = segmentGraphemes(String(text || ''));
  const chunks = [];
  let start = 0;

  while (start < graphemes.length) {
    const end = Math.min(start + maxLength, graphemes.length);
    if (end === graphemes.length) {
      chunks.push(graphemes.slice(start, end).join(''));
      break;
    }

    let cut = end;
    const candidate = graphemes.slice(start, end).join('');
    const preferred = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    if (preferred > 0) cut = start + preferred + 1;

    chunks.push(graphemes.slice(start, cut).join('').trimEnd());
    start = cut;
    while (start < graphemes.length && (graphemes[start] === '\n' || graphemes[start] === ' ')) start += 1;
  }

  return chunks.filter(Boolean);
}

function rcToTelegramText(text) {
  // Rocket.Chat Markdown is intentionally sent as raw text for this stage to avoid Telegram escaping errors.
  const converted = convertOutsideCode(text, replaceShortcodes);
  return splitTelegramText(converted);
}

function telegramToRcText(text) {
  return String(text || '').normalize('NFC');
}

module.exports = {
  rcToTelegramText,
  splitTelegramText,
  telegramToRcText,
};
