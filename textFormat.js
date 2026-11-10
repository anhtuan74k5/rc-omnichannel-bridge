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
  // Plain-text path: no formatting is interpreted. Used for bridge/system/AI messages.
  const converted = convertOutsideCode(text, replaceShortcodes);
  return splitTelegramText(converted);
}

// ---------------------------------------------------------------------------
// Rocket.Chat Markdown -> Telegram HTML
//
// Telegram HTML (parse_mode "HTML") is used instead of MarkdownV2 on purpose:
// it only needs `&`, `<` and `>` escaped, whereas MarkdownV2 requires escaping
// ~18 characters and fails the whole message (HTTP 400) when one is missed.
// Rocket.Chat accepts both single and double markers (`*b*`/`**b**`,
// `_i_`/`__i__`, `~s~`/`~~s~~`), and the composer toolbar inserts the double
// form, so both are handled.
// ---------------------------------------------------------------------------

const STASH_OPEN = '\uE000';
const STASH_CLOSE = '\uE001';
const STASH_PATTERN = /\uE000(\d+)\uE001/g;
const FENCE_MARGIN = 32;
const FENCE_PATTERN = /```(?:([A-Za-z0-9_+#.-]{1,20})[ \t]*\n|[ \t]*\n)?([\s\S]*?)```/g;
const SAFE_LINK_PATTERN = /\[([^\]\n]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^\s)]+)\)/g;
const BARE_URL_PATTERN = /\bhttps?:\/\/[^\s]+/g;

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyEmphasis(text) {
  return text
    .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, '<b>$1</b>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu, '<i>$1</i>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '<i>$1</i>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>')
    .replace(/(?<![\p{L}\p{N}~])~(?=[^\s~])([^\n~]*?[^\s~])~(?![\p{L}\p{N}~])/gu, '<s>$1</s>');
}

/**
 * Convert Rocket.Chat Markdown into Telegram-flavoured HTML.
 * Code spans/blocks and URLs are stashed first so that nothing inside them is
 * ever treated as formatting (e.g. snake_case_names, https://x.com/a_b_c).
 */
function rcMarkdownToTelegramHtml(source, { emphasis = true } = {}) {
  const stash = [];
  const hold = (html, plain) => {
    stash.push({ html, plain: plain === undefined ? html : plain });
    return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`;
  };
  const restore = (text, key) => {
    let result = text;
    for (let depth = 0; depth < 4 && result.includes(STASH_OPEN); depth += 1) {
      result = result.replace(STASH_PATTERN, (match, index) => (stash[index] ? stash[index][key] : ''));
    }
    return result;
  };

  let text = String(source || '').replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '');

  text = text.replace(FENCE_PATTERN, (match, language, code) => {
    const body = String(code || '').replace(/\n$/, '');
    if (!body.trim()) return match;
    const open = language ? `<pre><code class="language-${language}">` : '<pre>';
    const close = language ? '</code></pre>' : '</pre>';
    return hold(`${open}${escapeHtml(body)}${close}`, escapeHtml(body));
  });
  text = text.replace(/`([^`\n]+)`/g, (match, code) => (
    code.trim() ? hold(`<code>${escapeHtml(code)}</code>`, escapeHtml(code)) : match
  ));

  text = escapeHtml(text);

  text = text.replace(SAFE_LINK_PATTERN, (match, label, url) => {
    const labelHtml = restore(emphasis ? applyEmphasis(label) : label, 'plain');
    return hold(`<a href="${url.replace(/"/g, '&quot;')}">${labelHtml}</a>`);
  });
  text = text.replace(BARE_URL_PATTERN, (url) => {
    const trailing = (url.match(/[.,;:!?)\]]+$/) || [''])[0];
    const core = trailing ? url.slice(0, -trailing.length) : url;
    return `${hold(core)}${trailing}`;
  });

  if (emphasis) text = applyEmphasis(text);
  return restore(text, 'html');
}

const SELF_CONTAINED_TAGS = new Set(['code', 'pre', 'a']);

/**
 * Structural check for the small tag subset we emit. Telegram rejects the
 * whole message on bad nesting, and says `code`/`pre` cannot be combined with
 * other entities, so anything unsafe is caught here before the API call.
 */
function isWellFormedTelegramHtml(html) {
  const stack = [];
  const tagPattern = /<(\/?)(b|i|s|code|pre|a)(?:\s[^>]*)?>/g;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, closing, tag] = match;
    if (closing) {
      if (stack.pop() !== tag) return false;
      continue;
    }
    const top = stack[stack.length - 1];
    if (tag === 'pre' && stack.length > 0) return false;
    if (tag === 'code' && !(stack.length === 0 || (stack.length === 1 && top === 'pre'))) return false;
    if (tag === 'a' && stack.some((open) => SELF_CONTAINED_TAGS.has(open))) return false;
    if ((tag === 'b' || tag === 'i' || tag === 's') && stack.some((open) => open === 'code' || open === 'pre')) {
      return false;
    }
    stack.push(tag);
  }
  return stack.length === 0;
}

/**
 * Best-effort HTML for one message part, or null when the part carries no
 * formatting (callers then send plain text, with no parse_mode at all).
 * Degrades in tiers: full formatting -> code/links only -> plain text.
 */
function toTelegramHtml(source) {
  let html = rcMarkdownToTelegramHtml(source);
  if (!isWellFormedTelegramHtml(html)) html = rcMarkdownToTelegramHtml(source, { emphasis: false });
  if (!isWellFormedTelegramHtml(html)) return null;
  return html.includes('<') ? html : null;
}

function lastOpenFenceLanguage(chunk) {
  const index = chunk.lastIndexOf('```');
  const match = chunk.slice(index + 3).match(/^([A-Za-z0-9_+#.-]{1,20})[ \t]*\n/);
  return match ? match[1] : '';
}

/**
 * Split without leaving an unbalanced ``` fence: a fence cut in half is closed
 * at the end of one chunk and re-opened (same language) at the start of the next.
 */
function splitPreservingFences(text, maxLength) {
  if (!String(text || '').includes('```')) return splitTelegramText(text, maxLength);

  const parts = splitTelegramText(text, maxLength - FENCE_MARGIN);
  const chunks = [];
  let reopen = '';
  parts.forEach((part, index) => {
    let chunk = reopen + part;
    reopen = '';
    const isLast = index === parts.length - 1;
    // Only a chunk boundary can cut a fence in half; an odd count on the last
    // chunk is the author's own unclosed fence and is left untouched.
    if (!isLast && ((chunk.match(/```/g) || []).length) % 2 === 1) {
      reopen = `\`\`\`${lastOpenFenceLanguage(chunk)}\n`;
      chunk += '\n```';
    }
    chunks.push(chunk);
  });
  return chunks;
}

/**
 * Build the Telegram payload(s) for an outgoing message.
 *  - markdown=false: plain text only (bridge/system/AI messages).
 *  - markdown=true : Rocket.Chat Markdown rendered as Telegram HTML.
 * Splitting happens on the Markdown *source* so a tag is never cut in half;
 * Telegram measures the limit after parsing, so source length is conservative.
 * Each item keeps `source` so a caller can resend it as plain text if Telegram
 * rejects the formatted version.
 *
 * @returns {Array<{text: string, parseMode?: 'HTML', source: string}>}
 */
function buildTelegramMessages(text, { markdown = false, limit = 4096 } = {}) {
  const converted = convertOutsideCode(text, replaceShortcodes);
  if (!markdown) {
    return splitTelegramText(converted, limit).map((part) => ({ text: part, source: part }));
  }
  return splitPreservingFences(converted, limit).map((source) => {
    const html = toTelegramHtml(source);
    return html ? { text: html, parseMode: 'HTML', source } : { text: source, source };
  });
}

function telegramToRcText(text) {
  return String(text || '').normalize('NFC');
}

module.exports = {
  buildTelegramMessages,
  isWellFormedTelegramHtml,
  rcMarkdownToTelegramHtml,
  rcToTelegramText,
  splitTelegramText,
  telegramToRcText,
};
