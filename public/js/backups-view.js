'use strict';
// The backup browser's two DECISIONS — browser (classic script) AND Node (require'd by lib/backups.js and
// by the test suite). Dependency- and side-effect-free; no t()/DOM here (queue-merge.js / ctx.js spirit).
// Everything below returns TOKENS ('mtime', 'blocked', 'too-large', …); views-system.js translates them.
//
// WHY this exists as its own module. System → Backups showed 91 files (measured: ~/.claude/backups/
// claude-code-ui on this machine) as one flat, mtime-sorted column, and „Wiederherstellen" overwrote the
// destination without ever showing what would change. Both halves are decisions that have to be provable:
//
//  1. WHICH BACKUPS BELONG TOGETHER. Four writers invent the names, independently, in three shapes:
//       server.js:611  deleted-<uuid>-<ms>.jsonl                 (session delete — HYPHEN before the ms)
//       server.js:691  deleted-memory-<basename>.<ms>.bak        (memory delete)
//       server.js:776  deleted-<cfgkind>-<basename>.<ms>.bak     (agents/commands/output-styles delete)
//       lib/core.js:93 <basename>.<ISO>.bak                      (backupFile() before every edit)
//     `<basename>` carries its own dots (`MEMORY.md`, `settings.local.json`), so no rule here may cut at
//     the first one, and the stamp sits in two different spellings (ms vs. an ISO string with `:`/`.`
//     replaced by `-`). The file identity therefore comes from lib/backups.js classifyBackup() wherever
//     that one already answers (session/cfg/settings) and from a name rule only where it is silent —
//     because a SECOND classifier is how the two would drift apart.
//  2. WHAT A RESTORE WOULD DO. Three kinds, three different outcomes, and the dialog used to claim one
//     („wiederherstellen?") for all of them: settings COPIES over the destination, session and cfg
//     `fs.rename` and are REFUSED with 409 when the destination exists. So „überschreiben" is simply not
//     what happens in two of three cases, and a backup whose file no longer exists is a NEW file.
//
// A name nobody can parse stays VISIBLE (backupGroups → `unmatched`) instead of being dropped: a backup
// missing from the view is a backup its owner stops looking for.

// The two sides of a preview are each capped: a 100 MB transcript must not be read into the answer, and a
// line diff of it would not be readable anyway. Per side, so „which one is too big" stays answerable.
var BACKUP_DIFF_MAX_BYTES = 256 * 1024;
// The complete token sets. Exported so test/backups-view.test.js can assert that views-system.js handles
// every one of them: a token added here without a label there renders an empty dialog, and that is the
// failure this project keeps repeating (a tested half and an untested one).
var BACKUP_DIFF_TARGETS = ['new', 'overwrite', 'blocked'];
var BACKUP_DIFF_CONTENTS = ['diff', 'identical', 'binary', 'too-large'];
var BACKUP_STAMP_SOURCES = ['name', 'mtime'];
// What the dialog may say about the BACKUP's own fate (backupKeepNote) and what it may write over the diff
// (backupContentCaption). Two more sets, because both are decided per STATE and not per verdict: the same
// content can need a different sentence depending on whether a restore can run at all.
var BACKUP_NOTE_STATES = ['moved', 'kept', 'pruned-self', 'pruned-other'];
// DERIVED, not written down a second time: a new content token must get a caption, and the coverage check
// in test/backups-view.test.js then demands a label for it too.
var BACKUP_CAPTIONS = BACKUP_DIFF_CONTENTS.concat(['diff-blocked']);

// The moment the BACKUP was made, out of the name — not the file's mtime. They are not the same thing and
// not even usually the same day: `fs.rename` keeps the original file's mtime, so for the three
// `deleted-…` shapes mtime is when the session/file was last WRITTEN while the name carries when it was
// DELETED (measured: 27 of 91 backups here disagree by at least a day). The name is the one a writer put
// there on purpose, so the name wins. Returns null when there is no stamp to read — see backupStampOf.
// `\d{10,}`: `Date.now()` has had 13 digits since 2001 and keeps them until 2286, and the lower bound
// refuses the „1" in a hand-made `notes.1.bak` — a 4-digit number read as a timestamp would file that
// backup under 1970 and bury it at the bottom of the view for good.
function backupStampMs(name) {
  var n = String(name == null ? '' : name);
  var m;
  // `.<ms>.bak` — the memory (server.js:691) and cfg (server.js:776) deletes.
  if ((m = /\.(\d{10,})\.bak$/.exec(n))) return { ms: Number(m[1]), from: 'name' };
  // `-<ms>.jsonl` — the session delete (server.js:611) separates with a hyphen, and the uuid in front of
  // it contains hyphens too, so this is anchored at the END and never parsed left to right.
  if ((m = /-(\d{10,})\.jsonl$/.exec(n))) return { ms: Number(m[1]), from: 'name' };
  // `.<ISO>.bak` — backupFile()'s `new Date().toISOString().replace(/[:.]/g, '-')`. Undone field by
  // field rather than by a blanket replace: `2026-10-02T13-44-55-123Z` has four hyphens that must come
  // back as `:`/`.` and three in the DATE that must not.
  if ((m = /\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.bak$/.exec(n))) {
    var ms = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '.' + m[7] + 'Z');
    if (!isNaN(ms)) return { ms: ms, from: 'name' };
  }
  return null;
}
// …and the fallback. A stamp CAN be missing from a name the classifier still understands: its cfg rule
// accepts `[\dTZ.-]+` where the writer puts `Date.now()`, so `deleted-commands-x.md.-.bak` is a cfg
// backup with nothing to read. mtime is then the only date there is — and `from: 'mtime'` travels with it
// so the view can say where the date came from instead of presenting a file date as a backup date.
function backupStampOf(entry) {
  var s = backupStampMs(entry && entry.name);
  if (s) return s;
  var mt = Number(entry && entry.mtime);
  return { ms: isFinite(mt) ? mt : 0, from: 'mtime' };
}
// LOCAL day, never String(new Date(ms).toISOString()).slice(0, 10). Same rule and the same reason as
// lib/corpus.js dayKey (KORR-2): the timestamps are UTC, the user's „heute" is not, and a backup made at
// 00:30 Berlin time belongs to the day the user would call it — not to the one before. Derived through
// the Date API, so the DST boundary needs no special case.
function backupDayKey(ms) {
  var d = new Date(Number(ms) || 0);
  var p = function (v) { return (v < 10 ? '0' : '') + v; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// How many days ago that day is (0 = today, 1 = yesterday, null = not a day key). Compared between LOCAL
// midnights, so a day that is 23 or 25 hours long across a DST switch still counts as one day.
function backupDayOffset(day, nowMs) {
  var m = /^(\d+)-(\d{2})-(\d{2})$/.exec(String(day == null ? '' : day));
  if (!m) return null;
  var now = new Date(Number(nowMs) || Date.now());
  var a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var b = new Date(2000, Number(m[2]) - 1, Number(m[3]));
  b.setFullYear(Number(m[1])); // Date(y,…) maps 0-99 to 1900+y — same guard as corpus.js validDay
  if (isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

// The logical FILE a backup is a version of — the group key. `collection` is a token ('session', 'cfg
// kind', 'settings', 'memory', '' = unknown), never a label.
//
// The first three branches read what lib/backups.js classifyBackup() already decided, so a writer that
// changes its name format breaks ONE classifier and not two. The name rules below only cover what
// classifyBackup answers `{kind:'file'}` to: the memory delete and backupFile()'s own products.
function backupFileOf(entry) {
  var name = String((entry && entry.name) || '');
  var kind = entry && entry.kind;
  if (kind === 'session' && entry.id) return { key: 'session:' + entry.id, file: entry.id, collection: 'session' };
  if (kind === 'cfg' && entry.cfgKind && entry.target) return { key: 'cfg:' + entry.cfgKind + '/' + entry.target, file: entry.target + '.md', collection: entry.cfgKind };
  if (kind === 'settings' && entry.target) return { key: 'settings:' + entry.target, file: entry.target, collection: 'settings' };
  var m;
  // `deleted-memory-<basename>.<ms>.bak` (server.js:691). Before the generic rule below, so a memory
  // backup never lands in two different groups depending on which rule got there first.
  if ((m = /^deleted-memory-(.+)\.\d{10,}\.bak$/.exec(name))) return { key: 'memory:' + m[1], file: m[1], collection: 'memory' };
  // Any other `deleted-<rest>.<ms>.bak`. `<rest>` is kept VERBATIM and no collection is claimed: the cfg
  // kinds are a closed set (test/backups.test.js:50 pins that), so a `deleted-skills-x.md.…` can only be
  // hand-made — splitting it into „collection + file" would be a guess, and `commands-sync-active-sprint`
  // shows why a greedy split guesses wrong. Grouping it by its full name is still right: two backups of
  // the same hand-made name belong together.
  if ((m = /^deleted-(.+)\.\d{10,}\.bak$/.exec(name))) return { key: 'deleted:' + m[1], file: m[1], collection: '' };
  // backupFile()'s product for everything that is not settings.json/settings.local.json (a memory file,
  // a command, a subagent): `uiskill-demo.md.2026-09-24T…Z.bak`. The full ISO shape is required — a bare
  // `settings.json.bak` has no stamp, is NOT a backupFile product and is pinned as non-restorable.
  if ((m = /^(.+)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/.exec(name))) return { key: 'file:' + m[1], file: m[1], collection: '' };
  return null;
}

// Name-descending, as the tie-break that only exists because of a measured case: six session deletes here
// share the millisecond (…-1783677695457 and five siblings — one bulk delete), and two backups of the SAME
// file in the same millisecond are possible too. Without a total order the view would reshuffle on every
// repaint; localeCompare is deliberately avoided, the order must not depend on the UI language.
function backupCmpItems(a, b) {
  if (b.stampMs !== a.stampMs) return b.stampMs - a.stampMs;
  var x = String((a.entry && a.entry.name) || ''), y = String((b.entry && b.entry.name) || '');
  return x < y ? 1 : x > y ? -1 : 0;
}
function backupCmpKeyed(a, b, field) {
  if (b.newest !== a.newest) return b.newest - a.newest;
  return a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0;
}
// Day → file → versions, newest first at every level, plus `unmatched` for the names no rule reads.
// `total` is reported so the view can PROVE it drops nothing: the counts must add up to it, and
// test/backups-view.test.js asserts exactly that. The input array and its entries are never mutated —
// the caller keeps the server's answer.
function backupGroups(list) {
  var src = Array.isArray(list) ? list : [];
  var unmatched = [];
  var dayMap = new Map();
  src.forEach(function (entry) {
    var stamp = backupStampOf(entry);
    var item = { entry: entry, stampMs: stamp.ms, stampFrom: stamp.from };
    var f = backupFileOf(entry);
    if (!f) { unmatched.push(item); return; }
    var day = backupDayKey(stamp.ms);
    var dg = dayMap.get(day);
    if (!dg) { dg = { day: day, count: 0, newest: -Infinity, _files: new Map() }; dayMap.set(day, dg); }
    var fg = dg._files.get(f.key);
    if (!fg) {
      fg = { key: f.key, file: f.file, collection: f.collection, kind: (entry && entry.kind) || '', count: 0, newest: -Infinity, items: [] };
      dg._files.set(f.key, fg);
    }
    fg.items.push(item); fg.count++;
    if (item.stampMs > fg.newest) fg.newest = item.stampMs;
    dg.count++;
    if (item.stampMs > dg.newest) dg.newest = item.stampMs;
  });
  var days = [];
  dayMap.forEach(function (dg) {
    var files = [];
    dg._files.forEach(function (fg) { fg.items.sort(backupCmpItems); files.push(fg); });
    files.sort(function (a, b) { return backupCmpKeyed(a, b, 'key'); });
    days.push({ day: dg.day, count: dg.count, newest: dg.newest, files: files });
  });
  days.sort(function (a, b) { return backupCmpKeyed(a, b, 'day'); });
  unmatched.sort(backupCmpItems);
  return { days: days, unmatched: unmatched, total: src.length };
}

// Which restore OVERWRITES its destination, and which one CONSUMES the backup. Two questions, two
// predicates — not one negated twice, because a future kind could copy without overwriting.
// Pinned against the routes in test/backups-routes.test.js: settings copies the bytes over an existing
// file (server.js:1285-1300, settings-routes.test.js:253), session and cfg `fs.rename` and answer 409 when
// the destination exists (server.js:1272 / :1278) — so for those two „überschreiben" never happens, and
// the dialog must not offer a button that can only fail.
function backupRestoreOverwrites(kind) { return kind === 'settings'; }
function backupRestoreConsumes(kind) { return kind === 'session' || kind === 'cfg'; }

// Which backups the restore's OWN safety copy would delete — the answer that makes „das Backup bleibt
// erhalten" either true or a lie. A settings restore calls lib/core.js backupFile(dest) (server.js:1295);
// that one copies the destination into BACKUP_DIR and then keeps only the newest `keep` `<base>.*.bak`
// (lib/core.js:97-98). So AT the limit a restore costs a backup: either the one being restored (the repo
// has pinned that half for a long time — test/settings-routes.test.js:277 „the restored (oldest) one was
// the one pruned") or an uninvolved one, which the list cannot show either because it goes from 30 to 30.
// Measured in ~/.claude/backups/claude-code-ui: settings.local.json has exactly 30 versions, so this is
// one click away and not a thought experiment.
// Mirrors the prune's rule and nothing else: the same `startsWith(base + '.') && endsWith('.bak')` filter
// and the same plain lexicographic sort, so the two cannot disagree about WHICH file goes.
function backupRetentionPrune(p) {
  var o = p || {};
  // No copy, no prune. session/cfg are an `fs.rename` and never call backupFile, and when the destination
  // is gone backupFile answers ENOENT and copies nothing — so only an overwrite can cost anything. The
  // gate lives HERE and not in the caller: a second place that decides when to ask is a second place that
  // can forget to.
  if (!backupRestoreOverwrites(o.kind) || !o.exists) return [];
  var keep = Number(o.keep);
  var base = String(o.base == null ? '' : o.base);
  if (!base || !(keep > 0) || !Array.isArray(o.names)) return [];
  var mine = o.names.map(String).filter(function (n) { return n.indexOf(base + '.') === 0 && /\.bak$/.test(n); }).sort();
  // `+ 1` is the copy that is made BEFORE the prune runs. Its name is not invented here: it carries
  // `new Date().toISOString()`, so among ISO-stamped siblings it is the newest and can never be one of the
  // oldest — which is the only thing this count needs to know about it.
  return mine.slice(0, Math.max(0, mine.length + 1 - keep));
}

// What the dialog may claim about THIS backup once the restore has run. Four outcomes, and the reason it
// is a function instead of an `if` in the renderer: the move/keep sentence already had to learn once that
// it must stay SILENT in the blocked state (nothing is written there, so there is nothing to promise), and
// a rule that lives in the renderer has to be remembered by hand every time a case is added — which is
// exactly how the caption over the diff kept claiming an effect in that same state. null = say nothing.
function backupKeepNote(p) {
  var o = p || {};
  if (o.target === 'blocked') return null;
  if (backupRestoreConsumes(o.kind)) return 'moved';
  var gone = Array.isArray(o.prunes) ? o.prunes : [];
  // „this one goes" outranks „another one goes": with more than one name in the list (only reachable in a
  // BACKUP_DIR someone filled past the limit by hand) the renderer still prints all of them, so the second
  // casualty is named rather than swallowed.
  if (gone.indexOf(o.name) >= 0) return 'pruned-self';
  if (gone.length) return 'pruned-other';
  return 'kept';
}

// The line over the diff. „Das ändert das Wiederherstellen" is a claim about an EFFECT, and in the blocked
// state there is none: the restore answers 409 and the dialog deliberately offers no button, so the
// heading stood two elements under „… wird dann abgelehnt und nichts überschrieben" and contradicted it.
function backupContentCaption(p) {
  var o = p || {};
  if (o.content === 'diff' && o.target === 'blocked') return 'diff-blocked';
  return o.content;
}

// WHICH SIDE IS WHICH. public/js/render.js:362 is `renderDiff(oldStr, newStr, lang)` and it paints the
// first argument as the removals; a restore makes the file BECOME the backup, so the current content is
// the OLD side and the backup is the NEW one. Swapped, the dialog shows every restore mirrored: pulling a
// settings backup from „opus" back to „sonnet" would paint „sonnet" red and „opus" green, i.e. the exact
// opposite of the outcome. That is the one decision this whole dialog turns on, so it is named here and
// tested, instead of living as two bare arguments inside the renderer.
function backupDiffSides(p) {
  var o = p || {};
  return { old: o.currentText == null ? '' : String(o.currentText), new: o.backupText == null ? '' : String(o.backupText) };
}

// What the confirmation has to say before it overwrites anything. Two independent answers, because they
// are two independent questions and one word could not carry both:
//   target  — 'new' (the file is gone, the restore RE-CREATES it) · 'overwrite' · 'blocked' (the
//             destination exists and this kind refuses it with 409: a diff to read, no button to press)
//   content — 'diff' · 'identical' („dieses Backup ändert nichts") · 'binary' · 'too-large'
// ORDER matters and is the thing to pin: size is decided BEFORE binary-ness, because a side past the cap
// is never read and its bytes are therefore unknown. An unknown that presents itself as „text" is how a
// diff ends up showing nothing while the restore changes everything.
function backupDiffVerdict(p) {
  var o = p || {};
  var exists = !!o.exists;
  var limit = Number(o.limit) > 0 ? Number(o.limit) : BACKUP_DIFF_MAX_BYTES;
  var bk = o.backup || {};
  var cur = exists ? (o.current || {}) : null;
  var out = {
    target: !exists ? 'new' : (backupRestoreOverwrites(o.kind) ? 'overwrite' : 'blocked'),
    content: 'diff',
    consumes: backupRestoreConsumes(o.kind),
    bigSide: null, binarySide: null,
  };
  var curBig = !!(cur && Number(cur.bytes) > limit), bkBig = Number(bk.bytes) > limit;
  if (curBig || bkBig) { out.bigSide = curBig && bkBig ? 'both' : (bkBig ? 'backup' : 'current'); out.content = 'too-large'; return out; }
  var curBin = !!(cur && cur.binary), bkBin = !!bk.binary;
  if (curBin || bkBin) { out.binarySide = curBin && bkBin ? 'both' : (bkBin ? 'backup' : 'current'); out.content = 'binary'; return out; }
  // Compared as the strings the diff would be built from, so „identisch" means exactly „renderDiff would
  // draw no change" and never „the sizes match".
  if (cur && String(cur.text == null ? '' : cur.text) === String(bk.text == null ? '' : bk.text)) { out.content = 'identical'; return out; }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    backupStampMs, backupStampOf, backupDayKey, backupDayOffset,
    backupFileOf, backupGroups, backupCmpItems,
    backupRestoreOverwrites, backupRestoreConsumes, backupDiffVerdict,
    backupRetentionPrune, backupKeepNote, backupContentCaption, backupDiffSides,
    BACKUP_DIFF_MAX_BYTES, BACKUP_DIFF_TARGETS, BACKUP_DIFF_CONTENTS, BACKUP_STAMP_SOURCES,
    BACKUP_NOTE_STATES, BACKUP_CAPTIONS,
  };
}
