# test/fixtures — synthetic transcript corpus

Mirrors the layout of `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` so the session / search /
usage scanners can be tested against a known corpus instead of the developer's real history
(no personal data, no real project paths, tiny files).

The tests copy `projects/` into a temp dir and point the `CLAUDE_UI_CLAUDE_DIR` seam at it, so nothing
ever touches `~/.claude`. `test/sandbox.js` does the same for every server `verify.js`, `smoke-test.js`
and `test/integration.test.js` boot — so the live smoke folds these three files, not a 470 MB history.

| file | why it exists |
|---|---|
| `C--Users-dev-plain/1111…jsonl` | ordinary session: bookkeeping first line (no `cwd`), summary, 1 user + 1 assistant with priced usage |
| `C--Users-dev-plain/3333…jsonl` | assistant on an **unknown model** → exercises the unpriced-token accounting (F9) |
| `C--Users-dev-my-project/2222…jsonl` | **hyphenated** cwd (`my-project`): the dir name cannot be decoded back, so this is the F2 case; also carries umlauts/emoji for the byte-exact resumable parse (F6) and the unique search term `Zebrastreifen` |

Expected aggregates (asserted in the tests):

* 3 sessions · messages 2 / 3 / 3
* tokens: input 2110, output 1055, cacheRead 10, cacheWrite 20
* unpriced: 3000 tokens from `mystery-model-1`
* days: 2026-01-05, 2026-01-06, 2026-01-07
