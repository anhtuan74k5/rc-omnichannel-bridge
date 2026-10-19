/**
 * documents.js
 * ------------
 * Minimal local document store for per-user RAG.
 *
 * Documents are partitioned by platform + platformUserId so one customer never
 * retrieves another customer's uploaded context.
 */

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

const DATA_DIR = path.join(__dirname, 'data', 'documents');
const CHUNK_SIZE = Number(process.env.DOCUMENT_CHUNK_SIZE || 1200);
const CHUNK_OVERLAP = Number(process.env.DOCUMENT_CHUNK_OVERLAP || 150);
const DEFAULT_TOP_K = Number(process.env.DOCUMENT_TOP_K || 4);
const SUMMARY_TOP_K = Number(process.env.DOCUMENT_SUMMARY_TOP_K || 8);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.conf',
  '.env',
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were',
  'will', 'with', 'ban', 'cua', 'co', 'la', 'mot', 'nhung', 'thi', 'toi',
  'trong', 'va', 've', 'ai', 'bay', 'biet', 'cai', 'cho', 'da', 'day', 'do',
  'duoc', 'gi', 'gio', 'hien', 'hoi', 'khong', 'lam', 'may', 'nao', 'nay',
  'nhu', 'noi', 'tai', 'the', 'thi', 'z',
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getUserKey(platform, platformUserId) {
  const safePlatform = normalizeId(platform).toLowerCase();
  const safeUserId = normalizeId(platformUserId);
  if (!safePlatform || !safeUserId) {
    throw new Error('platform and platformUserId are required');
  }
  return `${safePlatform}_${safeUserId}`;
}

function getUserDir(platform, platformUserId) {
  return path.join(DATA_DIR, getUserKey(platform, platformUserId));
}

function getOriginalDir(platform, platformUserId) {
  return path.join(getUserDir(platform, platformUserId), 'original');
}

function getTextDir(platform, platformUserId) {
  return path.join(getUserDir(platform, platformUserId), 'text');
}

function getChunksPath(platform, platformUserId) {
  return path.join(getUserDir(platform, platformUserId), 'chunks.json');
}

function getExtension(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'document.txt'));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'document.txt';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \f\v]+/g, ' ')
    .trim();
}

function splitLongText(text, size, overlap) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks.filter(Boolean);
}

function chunkText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLongText(paragraph, CHUNK_SIZE, CHUNK_OVERLAP));
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > CHUNK_SIZE) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

function normalizeForIntent(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLatestDocumentReference(question) {
  const normalized = normalizeForIntent(question);
  const mentionsDocument = /\b(file|tai lieu|pdf|docx|document)\b/.test(normalized);
  const asksAboutContent = /\b(tom tat|noi ve|noi dung|vua gui|vua upload|vua tai|moi gui|moi upload|bai|de yeu cau|yeu cau|lam gi)\b/.test(normalized);

  return (mentionsDocument && asksAboutContent) || /\btom tat\b/.test(normalized);
}

function getLatestDocument(documents) {
  return [...documents]
    .filter((document) => document.filename)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
}

function readChunks(platform, platformUserId) {
  const chunksPath = getChunksPath(platform, platformUserId);
  if (!fs.existsSync(chunksPath)) {
    return { documents: [], chunks: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
    };
  } catch (err) {
    console.error(`[documents] Failed to read chunks for ${platform}:${platformUserId}:`, err.message);
    return { documents: [], chunks: [] };
  }
}

function buildIndex(platform, platformUserId) {
  const textDir = getTextDir(platform, platformUserId);
  const chunksPath = getChunksPath(platform, platformUserId);
  ensureDir(textDir);

  const filenames = fs.readdirSync(textDir)
    .filter((filename) => fs.statSync(path.join(textDir, filename)).isFile())
    .sort();

  const documents = [];
  const chunks = [];

  for (const filename of filenames) {
    const filePath = path.join(textDir, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    const textChunks = chunkText(content);
    const stat = fs.statSync(filePath);

    documents.push({
      filename: filename.replace(/\.txt$/, ''),
      textFilename: filename,
      size: stat.size,
      chunks: textChunks.length,
      updatedAt: stat.mtime.toISOString(),
    });

    textChunks.forEach((text, chunkIndex) => {
      chunks.push({
        id: `${filename}:${chunkIndex}`,
        filename: filename.replace(/\.txt$/, ''),
        chunkIndex,
        text,
      });
    });
  }

  const index = {
    userKey: getUserKey(platform, platformUserId),
    platform: String(platform),
    platformUserId: String(platformUserId),
    updatedAt: new Date().toISOString(),
    documents,
    chunks,
  };

  ensureDir(path.dirname(chunksPath));
  fs.writeFileSync(chunksPath, JSON.stringify(index, null, 2), 'utf8');
  return index;
}

function uploadDocument({ platform, platformUserId, filename, content }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content must be a non-empty string');
  }

  const originalDir = getOriginalDir(platform, platformUserId);
  const textDir = getTextDir(platform, platformUserId);
  ensureDir(originalDir);
  ensureDir(textDir);

  const safeFilename = sanitizeFilename(filename);
  fs.writeFileSync(path.join(originalDir, safeFilename), content, 'utf8');
  fs.writeFileSync(path.join(textDir, `${safeFilename}.txt`), content, 'utf8');

  const index = buildIndex(platform, platformUserId);
  const document = index.documents.find((doc) => doc.filename === safeFilename);

  console.log(`[documents] Uploaded ${safeFilename} for ${platform}:${platformUserId}`);
  return {
    userKey: index.userKey,
    filename: safeFilename,
    document,
    totalDocuments: index.documents.length,
    totalChunks: index.chunks.length,
  };
}

async function extractTextFromBuffer(filename, buffer) {
  const extension = getExtension(filename);

  if (TEXT_EXTENSIONS.has(extension)) {
    return buffer.toString('utf8');
  }

  if (extension === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return parsed.text || '';
    } finally {
      await parser.destroy();
    }
  }

  if (extension === '.docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }

  throw new Error(`Unsupported document type "${extension || 'unknown'}".`);
}

async function uploadDocumentBuffer({ platform, platformUserId, filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('buffer must be a non-empty Buffer');
  }

  const safeFilename = sanitizeFilename(filename);
  const content = normalizeText(await extractTextFromBuffer(safeFilename, buffer));
  if (!content) {
    throw new Error(`Could not extract readable text from "${safeFilename}".`);
  }

  const originalDir = getOriginalDir(platform, platformUserId);
  const textDir = getTextDir(platform, platformUserId);
  ensureDir(originalDir);
  ensureDir(textDir);

  fs.writeFileSync(path.join(originalDir, safeFilename), buffer);
  fs.writeFileSync(path.join(textDir, `${safeFilename}.txt`), content, 'utf8');

  const index = buildIndex(platform, platformUserId);
  const document = index.documents.find((doc) => doc.filename === safeFilename);

  console.log(`[documents] Uploaded ${safeFilename} for ${platform}:${platformUserId}`);
  return {
    userKey: index.userKey,
    filename: safeFilename,
    document,
    totalDocuments: index.documents.length,
    totalChunks: index.chunks.length,
  };
}

function listDocuments(platform, platformUserId) {
  const index = readChunks(platform, platformUserId);
  return {
    userKey: getUserKey(platform, platformUserId),
    documents: index.documents,
    totalChunks: index.chunks.length,
  };
}

function retrieveRelevantChunks(platform, platformUserId, question, limit = DEFAULT_TOP_K) {
  const index = readChunks(platform, platformUserId);
  const hasDocuments = index.chunks.length > 0;
  if (!hasDocuments) {
    return { hasDocuments: false, chunks: [] };
  }

  if (isLatestDocumentReference(question)) {
    const latestDocument = getLatestDocument(index.documents);
    if (latestDocument) {
      const chunks = index.chunks
        .filter((chunk) => chunk.filename === latestDocument.filename)
        .slice(0, Math.max(limit, SUMMARY_TOP_K));
      if (chunks.length > 0) {
        return { hasDocuments: true, chunks };
      }
    }
  }

  const queryTerms = tokenize(question);
  if (queryTerms.length === 0) {
    return { hasDocuments: true, chunks: [] };
  }

  const querySet = new Set(queryTerms);
  const scored = index.chunks
    .map((chunk) => {
      const textTerms = tokenize(`${chunk.filename} ${chunk.text}`);
      const textTermCounts = new Map();
      for (const term of textTerms) {
        textTermCounts.set(term, (textTermCounts.get(term) || 0) + 1);
      }

      let score = 0;
      for (const term of querySet) {
        if (textTermCounts.has(term)) {
          score += 1 + Math.log(1 + textTermCounts.get(term));
        }
      }

      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { hasDocuments: true, chunks: scored };
}

module.exports = {
  buildIndex,
  getUserKey,
  listDocuments,
  retrieveRelevantChunks,
  uploadDocument,
  uploadDocumentBuffer,
};
