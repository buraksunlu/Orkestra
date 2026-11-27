'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/renderer/dropPaths');

test('a macOS screenshot name is escaped like Terminal.app does it', () => {
  assert.equal(
    D.dropText(['/Users/x/Desktop/Screenshot 2026-11-27 at 11.02.13.png']),
    '/Users/x/Desktop/Screenshot\\ 2026-11-27\\ at\\ 11.02.13.png ',
  );
});

test('several files, odd characters, and empty input', () => {
  assert.equal(D.dropText(["/tmp/a b/it's (1).png", '/tmp/plain.txt']), "/tmp/a\\ b/it\\'s\\ \\(1\\).png /tmp/plain.txt ");
  assert.equal(D.dropText([]), '');
  assert.equal(D.dropText(['', null]), '');
});

test('file URLs from a uri-list', () => {
  assert.deepEqual(
    D.pathsFromUriList('# comment\nfile:///Users/x/Desktop/Ekran%20Resmi%202026.png\r\nhttps://example.com/x.png\n'),
    ['/Users/x/Desktop/Ekran Resmi 2026.png'],
  );
});

test('image names', () => {
  assert.ok(D.isImageName('Ekran Resmi 2026-11-27 11.02.13.png'));
  assert.ok(D.isImageName('a.JPEG'));
  assert.ok(!D.isImageName('notes.md'));
});
