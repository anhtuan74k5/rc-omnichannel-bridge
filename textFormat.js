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

// ---------------------------------------------------------------------------
// Rocket.Chat timestamps  <t:2026-11-10T13:07:38.825+00:00:f>
//
// The composer inserts `<t:ISO_OR_UNIX:FORMAT>`. Telegram has a native
// date-time entity (HTML: <tg-time unix="..." format="...">fallback</tg-time>)
// which each reader sees in their own timezone/locale, so it is used when the
// instant is valid. The element text is a pre-formatted fallback (in the
// bridge timezone) for clients that do not render the entity, and the same
// fallback is used for plain-text channels (Facebook, parse-error resend).
//
//   RC  t  T  d  D  f   F    R
//   TG  t  T  d  D  dt  wDt  r      (Telegram format string: r | w?[dD]?[tT]?)
// ---------------------------------------------------------------------------

const TIMESTAMP_PATTERN = /<t:(\d{4}-\d{2}-\d{2}T[^>\s]*?|\d{9,13})(?::([tTdDfFR]))?>/g;
const TELEGRAM_TIME_FORMATS = Object.freeze({ t: 't', T: 'T', d: 'd', D: 'D', f: 'dt', F: 'wDt', R: 'r' });
// Telegram accepts unix dates from 0 up to now + 1098 days.
const TELEGRAM_MAX_FUTURE_MS = 1090 * 24 * 60 * 60 * 1000;
const DEFAULT_TIME_LOCALE = 'vi-VN';
const DEFAULT_TIME_ZONE = 'Asia/Bangkok';

function parseRcTimestamp(raw) {
  const value = /^\d+$/.test(raw)
    ? new Date(raw.length <= 10 ? Number(raw) * 1000 : Number(raw))
    : new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

function resolveTimeOptions(options = {}) {
  const timeZone = options.timeZone || process.env.TZ || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat(DEFAULT_TIME_LOCALE, { timeZone });
    return { locale: options.locale || DEFAULT_TIME_LOCALE, timeZone, now: options.now };
  } catch (err) {
    return { locale: options.locale || DEFAULT_TIME_LOCALE, timeZone: DEFAULT_TIME_ZONE, now: options.now };
  }
}

function formatRelative(date, locale, now) {
  const diffSeconds = Math.round((date.getTime() - now) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return rtf.format(diffSeconds, 'second');
}

/** Human-readable text for one timestamp, in the bridge timezone. */
function formatTimestampText(date, format = 'f', options = {}) {
  const { locale, timeZone, now } = resolveTimeOptions(options);
  const fmt = (opts) => new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(date);
  const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const longDate = { day: 'numeric', month: 'long', year: 'numeric' };
  switch (format) {
    case 't': return fmt(time);
    case 'T': return fmt({ ...time, second: '2-digit' });
    case 'd': return fmt({ day: '2-digit', month: '2-digit', year: 'numeric' });
    case 'D': return fmt(longDate);
    case 'F': return `${fmt({ weekday: 'long', ...longDate })} ${fmt(time)}`;
    case 'R': return formatRelative(date, locale, now === undefined ? Date.now() : now);
    case 'f':
    default: return `${fmt(longDate)} ${fmt(time)}`;
  }
}

/** Replace every <t:...> with readable text (plain-text channels / fallbacks). */
function rcTimestampsToPlainText(text, options = {}) {
  return String(text || '').replace(TIMESTAMP_PATTERN, (match, raw, format) => {
    const date = parseRcTimestamp(raw);
    return date ? formatTimestampText(date, format || 'f', options) : match;
  });
}

/** Telegram HTML for one timestamp, or null when it must degrade to plain text. */
function timestampToTelegramHtml(raw, format, options = {}) {
  const date = parseRcTimestamp(raw);
  if (!date) return null;
  const fallback = escapeHtml(formatTimestampText(date, format || 'f', options));
  const ms = date.getTime();
  const { now } = resolveTimeOptions(options);
  const inRange = ms >= 0 && ms <= (now === undefined ? Date.now() : now) + TELEGRAM_MAX_FUTURE_MS;
  if (!inRange) return { html: fallback, plain: fallback };
  const unix = Math.floor(ms / 1000);
  const tgFormat = TELEGRAM_TIME_FORMATS[format || 'f'];
  return {
    html: `<tg-time unix="${unix}" format="${tgFormat}">${fallback}</tg-time>`,
    plain: fallback,
  };
}

/**
 * Convert Rocket.Chat Markdown into Telegram-flavoured HTML.
 * Code spans/blocks and URLs are stashed first so that nothing inside them is
 * ever treated as formatting (e.g. snake_case_names, https://x.com/a_b_c).
 */
function rcMarkdownToTelegramHtml(source, { emphasis = true, timeOptions } = {}) {
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

  // Timestamps are held before escaping: `<t:...>` would otherwise become `&lt;t:...&gt;`.
  text = text.replace(TIMESTAMP_PATTERN, (match, raw, format) => {
    const rendered = timestampToTelegramHtml(raw, format, timeOptions);
    return rendered ? hold(rendered.html, rendered.plain) : match;
  });

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

const SELF_CONTAINED_TAGS = new Set(['code', 'pre', 'a', 'tg-time']);

/**
 * Structural check for the small tag subset we emit. Telegram rejects the
 * whole message on bad nesting, and says `code`/`pre` cannot be combined with
 * other entities, so anything unsafe is caught here before the API call.
 */
function isWellFormedTelegramHtml(html) {
  const stack = [];
  const tagPattern = /<(\/?)(b|i|s|code|pre|a|tg-time)(?:\s[^>]*)?>/g;
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
    if ((tag === 'a' || tag === 'tg-time') && stack.some((open) => SELF_CONTAINED_TAGS.has(open))) return false;
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
function toTelegramHtml(source, timeOptions) {
  let html = rcMarkdownToTelegramHtml(source, { timeOptions });
  if (!isWellFormedTelegramHtml(html)) html = rcMarkdownToTelegramHtml(source, { emphasis: false, timeOptions });
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
function buildTelegramMessages(text, { markdown = false, limit = 4096, timeOptions } = {}) {
  const converted = convertOutsideCode(text, replaceShortcodes);
  if (!markdown) {
    return splitTelegramText(converted, limit).map((part) => ({ text: part, source: part }));
  }
  return splitPreservingFences(converted, limit).map((chunk) => {
    const html = toTelegramHtml(chunk, timeOptions);
    // `source` is what gets resent as plain text if Telegram rejects the HTML,
    // so raw <t:...> markers are already turned into readable dates there.
    const source = rcTimestampsToPlainText(chunk, timeOptions);
    return html ? { text: html, parseMode: 'HTML', source } : { text: source, source };
  });
}

function telegramToRcText(text) {
  return String(text || '').normalize('NFC');
}

function unescapeHtml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Telegram-subset HTML (as produced above) -> plain text. */
function telegramHtmlToPlain(html) {
  const plain = html
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (match, url, label) => {
      const text = label.replace(/<[^>]+>/g, '');
      return unescapeHtml(text) === unescapeHtml(url) ? text : `${text} (${url})`;
    })
    .replace(/<tg-time[^>]*>([\s\S]*?)<\/tg-time>/g, '$1')
    .replace(/<\/?(?:b|i|s|code|pre)(?:\s[^>]*)?>/g, '');
  return unescapeHtml(plain);
}

/**
 * Rocket.Chat Markdown -> readable plain text for channels without formatting
 * (Facebook Messenger): markers are dropped, code keeps its content, links keep
 * their URL, timestamps become dates, shortcodes become emoji. Reuses the same
 * parser as the Telegram path, so snake_case, `2 * 3 * 4` and URLs stay intact.
 */
function rcMarkdownToPlainText(source, { timeOptions } = {}) {
  const converted = convertOutsideCode(source, replaceShortcodes);
  let html = rcMarkdownToTelegramHtml(converted, { timeOptions });
  if (!isWellFormedTelegramHtml(html)) html = rcMarkdownToTelegramHtml(converted, { emphasis: false, timeOptions });
  if (!isWellFormedTelegramHtml(html)) return rcTimestampsToPlainText(converted, timeOptions);
  return telegramHtmlToPlain(html);
}

/**
 * Split for channels that count UTF-16 code units (Messenger: 2000). The
 * grapheme-based splitter can exceed that for emoji-heavy text, so retry with a
 * smaller grapheme limit until every part fits.
 */
function splitByUtf16(text, maxUnits) {
  const graphemes = segmentGraphemes(String(text || ''));
  const chunks = [];
  let start = 0;

  while (start < graphemes.length) {
    let end = start;
    let units = 0;
    while (end < graphemes.length && units + graphemes[end].length <= maxUnits) {
      units += graphemes[end].length;
      end += 1;
    }
    if (end === graphemes.length) {
      chunks.push(graphemes.slice(start).join(''));
      break;
    }
    if (end === start) end = start + 1; // a single grapheme longer than the limit

    // Prefer a line break, then a space, as long as it is not near the start.
    const window = graphemes.slice(start, end);
    const lineBreak = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const minimum = Math.floor(window.length * 0.4);
    let cut = end;
    if (lineBreak >= minimum) cut = start + lineBreak + 1;
    else if (space >= minimum) cut = start + space + 1;
    else if (lineBreak > 0) cut = start + lineBreak + 1;
    else if (space > 0) cut = start + space + 1;

    chunks.push(graphemes.slice(start, cut).join('').trimEnd());
    start = cut;
    while (start < graphemes.length && (graphemes[start] === '\n' || graphemes[start] === ' ')) start += 1;
  }

  return chunks.filter(Boolean);
}

module.exports = {
  rcMarkdownToPlainText,
  splitByUtf16,
  buildTelegramMessages,
  isWellFormedTelegramHtml,
  formatTimestampText,
  rcMarkdownToTelegramHtml,
  rcTimestampsToPlainText,
  rcToTelegramText,
  splitTelegramText,
  telegramToRcText,
};
