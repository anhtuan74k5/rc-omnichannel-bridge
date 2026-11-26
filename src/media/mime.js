const EXTENSION_KINDS = Object.freeze({
  '.gif': 'animation',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.ogg': 'voice',
  '.oga': 'voice',
  '.opus': 'voice',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.mp4a': 'audio',
  '.wav': 'audio',
});

function getExtension(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function classifyMime(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase().trim();
  const baseMime = mime.split(';', 1)[0].trim();
  const extensionKind = EXTENSION_KINDS[getExtension(filename)];

  if (baseMime === 'image/gif' || extensionKind === 'animation') return 'animation';
  if (baseMime.startsWith('image/')) return 'image';
  if (baseMime.startsWith('video/')) return 'video';
  if (baseMime === 'audio/ogg' && /\bcodecs\s*=\s*"?[^"]*\bopus\b/i.test(mime)) return 'voice';
  if (baseMime === 'audio/ogg') return 'document';
  if (['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'].includes(baseMime)) return 'audio';
  if (baseMime.startsWith('audio/')) return 'document';
  return extensionKind || 'document';
}

module.exports = { classifyMime };
