const test = require('node:test');
const assert = require('node:assert/strict');
const { sniffExtension } = require('../media/facebookFiles');

const pad = (head) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(16)]);

test('sniffExtension names common media from magic bytes', () => {
  assert.equal(sniffExtension(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), '.wav');
  assert.equal(sniffExtension(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])), '.mp4');
  assert.equal(sniffExtension(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)])), '.m4a');
  assert.equal(sniffExtension(pad('OggS')), '.ogg');
  assert.equal(sniffExtension(pad('ID3')), '.mp3');
  assert.equal(sniffExtension(pad('%PDF-1.4')), '.pdf');
  assert.equal(sniffExtension(pad('PK\u0003\u0004')), '.zip');
  assert.equal(sniffExtension(Buffer.from([0xff, 0xd8, 0xff, ...Array(12).fill(0)])), '.jpg');
  assert.equal(sniffExtension(Buffer.alloc(20)), '');
  assert.equal(sniffExtension(Buffer.alloc(3)), '');
  assert.equal(sniffExtension(null), '');
});
