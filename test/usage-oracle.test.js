'use strict';
// THE REGRESSION ORACLE, against the LIVE corpus — opt-in, slow, read-only.
//
//   CCUI_ORACLE=1 node --test test/usage-oracle.test.js
//
// Why it is opt-in: it folds the developer's real ~/.claude/projects (586 MB, ~20-40 s) and it is the only
// suite in the repo that touches real data. verify.js must stay fast and CI-safe, so without the env var
// every assertion here is skipped. The same assertion runs on a fixture in test/corpus.test.js, so the
// fast suite is not blind to a regression.
//
// What it asserts: the CLI writes its OWN cost verdict into the transcript as a `type:"cost-state"` frame
// (150 of 464 files on the measured corpus, 152 lines). Its summed modelUsage[*].outputTokens equals the
// DEDUPED output exactly on 146 of 150 files; counting every usage line matches 1 of 150 and is 2.11x
// high. So this is the one check that would have caught BOTH the duplicate counting and the 50 % Sonnet
// rate — the two bugs that made every cost this panel printed wrong.
//
// It prints AGGREGATES ONLY — counts, ratios, session-id prefixes. Never a prompt, an answer or a path.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ON = process.env.CCUI_ORACLE === '1';
// The live corpus, deliberately explicit: every other suite (and test/sandbox.js) points
// CLAUDE_UI_CLAUDE_DIR at a fixture tree, so without this the "live" oracle would silently read 3 files.
if (ON) process.env.CLAUDE_UI_CLAUDE_DIR = process.env.CCUI_ORACLE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
// …but the fold cache goes to a throwaway dir, so a measurement run can never write into the real panel's
// store or leave anything behind.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-oracle-'));
process.env.CLAUDE_UI_DATA_DIR = TMP;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { scanCorpus } = require('../lib/corpus');
const { costParts } = require('../lib/core');

const TOL = 0.01; // 1 %: the corpus is LIVE, the active session grows between the fold and the assertion

describe('lib/usage — the CLI\'s own cost-state as the oracle (live corpus)', () => {
  let rows = [], stats = null;
  before(async () => {
    if (!ON) return;
    const corpus = await scanCorpus();
    stats = corpus.stats;
    for (const rec of corpus.recs) {
      if (!rec.cs) continue;
      let out = 0, cost = 0, tokens = 0;
      for (const day in rec.d) {
        for (const model in rec.d[day].m) {
          const b = rec.d[day].m[model];
          out += b[1];
          tokens += b[0] + b[1] + b[2] + b[3];
          cost += costParts({ input_tokens: b[0], output_tokens: b[1], cache_read_input_tokens: b[2], cache_creation_input_tokens: b[3], cache_creation: { ephemeral_5m_input_tokens: b[4], ephemeral_1h_input_tokens: b[5] } }, model).total;
        }
      }
      rows.push({ id: rec.session.slice(0, 8), kind: rec.kind, cliOut: rec.cs.o, cliCost: rec.cs.c, unknown: rec.cs.unknown, out, cost, tokens });
    }
  });

  it('every transcript that carries a cost-state line is folded without a single fold error', { skip: !ON && 'set CCUI_ORACLE=1' }, () => {
    assert.ok(rows.length >= 50, 'expected the live corpus to carry cost-state frames, found ' + rows.length);
    assert.equal(stats.foldErrors, 0, 'fold errors: ' + stats.foldErrors + ' first=' + stats.foldError);
    console.log('    oracle: ' + rows.length + ' of ' + stats.files + ' files carry a cost-state frame (' + stats.projects + ' projects)');
  });

  it('the deduped OUTPUT tokens equal the CLI\'s own outputTokens', { skip: !ON && 'set CCUI_ORACLE=1' }, () => {
    const cmp = rows.filter((r) => r.cliOut > 0);
    const exact = cmp.filter((r) => r.out === r.cliOut).length;
    const near = cmp.filter((r) => Math.abs(r.out - r.cliOut) <= Math.max(1, r.cliOut * TOL)).length;
    const cliSum = cmp.reduce((a, r) => a + r.cliOut, 0), ourSum = cmp.reduce((a, r) => a + r.out, 0);
    console.log('    output tokens: ' + exact + '/' + cmp.length + ' EXACT, ' + near + '/' + cmp.length + ' within 1 % · CLI ' + cliSum.toLocaleString('en-US') + ' vs folded ' + ourSum.toLocaleString('en-US') + ' (' + (ourSum / cliSum).toFixed(4) + 'x)');
    // The measured baseline is 146/150 exact. Counting every usage line scored 1/150 and 2.11x — so the
    // bar here is deliberately far below the measurement and still miles above the old behaviour.
    assert.ok(exact / cmp.length >= 0.9, 'only ' + exact + ' of ' + cmp.length + ' sessions match the CLI exactly — the dedup rule regressed');
    assert.ok(Math.abs(ourSum / cliSum - 1) <= 0.05, 'summed output is ' + (ourSum / cliSum).toFixed(3) + 'x the CLI\'s own figure');
  });

  it('the computed COST matches the CLI\'s own totalCostUSD', { skip: !ON && 'set CCUI_ORACLE=1' }, () => {
    // hasUnknownModelCost means the CLI itself could not price part of the session — not comparable.
    const cmp = rows.filter((r) => r.cliCost > 0.01 && !r.unknown);
    const near = cmp.filter((r) => Math.abs(r.cost - r.cliCost) <= Math.max(0.01, r.cliCost * 0.02)).length;
    const cliSum = cmp.reduce((a, r) => a + r.cliCost, 0), ourSum = cmp.reduce((a, r) => a + r.cost, 0);
    const worst = cmp.slice().sort((a, b) => Math.abs(b.cost / (b.cliCost || 1) - 1) - Math.abs(a.cost / (a.cliCost || 1) - 1)).slice(0, 3)
      .map((r) => r.id + ' ' + (r.cost / r.cliCost).toFixed(3) + 'x').join(' · ');
    console.log('    cost: ' + near + '/' + cmp.length + ' within 2 % · CLI $' + cliSum.toFixed(2) + ' vs computed $' + ourSum.toFixed(2) + ' (' + (ourSum / cliSum).toFixed(4) + 'x) · worst: ' + worst);
    // Before PR-4 this ratio was 2.50-2.52x from the duplicate counting and a further 1.50x on every
    // Sonnet 5 row. 10 % is the honest tolerance: list prices are estimates and the corpus is live.
    assert.ok(Math.abs(ourSum / cliSum - 1) <= 0.10, 'computed cost is ' + (ourSum / cliSum).toFixed(3) + 'x the CLI\'s own total');
  });
});
