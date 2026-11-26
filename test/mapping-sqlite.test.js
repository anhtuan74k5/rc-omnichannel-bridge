const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
const skip = major < 22 || (major === 22 && minor < 13) ? 'node:sqlite needs Node 22.13+' : false;
const root = path.join(__dirname, '..');

/** Each step runs in its own process, like a restart of the bridge. */
function run(dir, script, env = {}) {
  const code = `console.log = () => {}; const mapping = require('./src/core/mapping'); mapping.load(); ${script}`;
  return execFileSync(process.execPath, ['-e', code], {
    cwd: root,
    env: {
      ...process.env,
      MAPPING_STORE: 'sqlite',
      MAPPING_FILE: path.join(dir, 'mapping.json'),
      MAPPING_DB: '',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const dump = "process.stdout.write(JSON.stringify(mapping.getActiveEntries()))";

test('entries survive a restart', { skip }, (t) => {
  const dir = tempDir(t);
  run(dir, `const e = mapping.getOrCreate('telegram', 1);
    mapping.update(e, { visitorToken: 'v1', roomId: 'r1' });
    mapping.markInboundProcessed(e, 'mid-1');
    mapping.getOrCreate('facebook', 1);`);
  const [entry, ...rest] = JSON.parse(run(dir, dump));
  assert.equal(rest.length, 0);
  assert.equal(entry.roomId, 'r1');
  assert.deepEqual(entry.processedInboundIds, ['mid-1']);
  assert.ok(fs.existsSync(path.join(dir, 'mapping.db')));
});

test('an existing JSON file is imported once and left untouched', { skip }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'mapping.json');
  const original = JSON.stringify({ entries: [{
    platform: 'telegram', platformUserId: '7', visitorToken: 'v7', roomId: 'r7', active: true,
  }] });
  fs.writeFileSync(file, original);

  run(dir, "mapping.update(mapping.findByPlatformUser('telegram', 7), { roomId: 'newer' });");
  const entries = JSON.parse(run(dir, dump));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].roomId, 'newer', 'the JSON file is not imported a second time');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('an unknown MAPPING_STORE stops instead of starting an empty store', (t) => {
  assert.throws(() => run(tempDir(t), '', { MAPPING_STORE: 'sqlit' }), /MAPPING_STORE must be/);
});
