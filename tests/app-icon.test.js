'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('extension maintains the existing ID and v1.1.0 version', () => {
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.browser_specific_settings.gecko.id, '{d573c284-f17e-4a66-9834-2cbf0477d960}');
});

test('48px, 96px and 128px official app icons exist and have correct PNG dimensions', () => {
  for (const size of [48,96,128]) {
    const filename = `icons/app-${size}.png`;
    assert.equal(manifest.icons[String(size)], filename);
    const bytes = fs.readFileSync(path.join(root, filename));
    assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

test('toolbar default and three action-state icons remain unchanged', () => {
  assert.equal(manifest.action.default_icon, 'icons/unsaved.svg');
  for (const name of ['unsaved','saved','excluded']) {
    const file = path.join(root, 'icons', `${name}.svg`);
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, 'utf8'), /<svg\b/);
  }
});
