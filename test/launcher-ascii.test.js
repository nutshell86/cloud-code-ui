'use strict';
// start.cmd -> `powershell -File start.ps1` is Windows PowerShell 5.1, which reads a BOM-less file as cp1252:
// the UTF-8 dash "—" (E2 80 94) ends in 0x94 = a typographic quote, which closes a "..." string early and the
// whole launcher dies at PARSE time (05.10.: start.cmd opened nothing). So the launchers stay pure ASCII.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('launchers are ASCII-only (Windows PowerShell 5.1 reads BOM-less files as cp1252)', () => {
  for (const f of ['start.cmd', 'start.ps1', 'stop.cmd', 'stop.ps1']) {
    it(f, () => {
      const bad = [];
      fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).forEach((l, i) => {
        if (/[^\x00-\x7F]/.test(l)) bad.push(`${i + 1}: ${l.slice(0, 60)}`);
      });
      assert.deepEqual(bad, [], `${f} has non-ASCII characters`);
    });
  }
});
