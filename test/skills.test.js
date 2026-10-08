'use strict';
// Unit tests for lib/skills.js extractUiManifest — pulls the ```ui-skill``` JSON block out of a command's markdown.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extractUiManifest, memoryPath } = require('../lib/skills');

const withBlock = [
  '# My skill',
  'Some prose describing it.',
  '',
  '```ui-skill',
  '{ "version": 1, "title": "Demo", "inputs": [] }',
  '```',
  '',
  'More prose.',
].join('\n');

test('extractUiManifest returns the parsed manifest object', () => {
  const m = extractUiManifest(withBlock);
  assert.ok(m && typeof m === 'object');
  assert.equal(m.title, 'Demo');
  assert.equal(m.version, 1);
});

test('extractUiManifest returns null when there is no ui-skill block', () => {
  assert.equal(extractUiManifest('# plain command\n\njust prose, no block'), null);
  assert.equal(extractUiManifest(''), null);
  assert.equal(extractUiManifest(null), null);
});

// #24: `project` is ONE directory entry under PROJECTS_DIR (scanSessions reports `d.name`), so it is
// held to the same separator rule as the file name — and the containment check is anchored on
// PROJECTS_DIR, not on a bound composed from the argument it is supposed to bound.
test('memoryPath refuses anything that is not <project>/memory/<name>.md', () => {
  const ok = memoryPath('C--Users-x', 'MEMORY.md');
  assert.ok(ok && ok.endsWith(path.join('C--Users-x', 'memory', 'MEMORY.md')), 'a plain project name still resolves');
  for (const project of ['a/b', 'a\\b', '..', 'a/../..', '']) {
    assert.equal(memoryPath(project, 'MEMORY.md'), null, JSON.stringify(project) + ' must not be a project');
  }
  for (const name of ['../x.md', 'a/b.md', 'a\\b.md', 'notes.txt', '']) {
    assert.equal(memoryPath('C--Users-x', name), null, JSON.stringify(name) + ' must not be a memory file');
  }
});

test('extractUiManifest returns null on a malformed JSON block', () => {
  const bad = '```ui-skill\n{ not valid json ]\n```';
  assert.equal(extractUiManifest(bad), null);
});
