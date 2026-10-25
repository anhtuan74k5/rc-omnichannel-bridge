const test = require('node:test');
const assert = require('node:assert/strict');

const { extractAttachments } = require('../rocketchat');

test('extractAttachments prefers Rocket.Chat attachment title_link over publicFilePath', () => {
  const [attachment] = extractAttachments({
    file: {
      _id: 'file-id',
      name: 'Audio record.mp3',
      type: 'audio/mpeg',
      size: 123,
    },
    files: [{
      _id: 'file-id',
      name: 'Audio record.mp3',
      type: 'audio/mpeg',
      size: 123,
    }],
    attachments: [{
      fileId: 'file-id',
      title: 'Audio record.mp3',
      title_link: '/file-upload/file-id/Audio%20record.mp3',
      mimeType: 'audio/mpeg',
      size: 123,
    }],
    fileUpload: {
      publicFilePath: 'http://localhost:3001/file-upload/file-id/Audio%20record.mp3',
    },
  });

  assert.equal(attachment.source, '/file-upload/file-id/Audio%20record.mp3');
  assert.equal(attachment.filename, 'Audio record.mp3');
  assert.equal(attachment.kind, 'audio');
});
