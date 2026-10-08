'use strict';
// Which restored tabs belong to which panel WINDOW (CHAT-FLOW-4 part B) — browser (classic script) AND Node
// (require'd by the test suite). No DOM, no t(), no storage of its own: the caller hands in the stored list, the
// Web Locks manager (navigator.locks) and sessionStorage, so every rule here runs in a test as it runs in the page.
//
// WHY: `cc_tabs` was ONE key for every window. Each window wrote its complete tab list over the other's, and a
// window that booted restored whatever the last writer had left — the other window's tabs and its active session
// included, which it then resumed (the ping-pong part A stopped on the server). Tabs opened in B vanished on A's
// next keystroke, a tab closed in B came back through A, drafts were overwritten, and a reload of A landed on B's
// active session.
//
// THE MODEL:
//  · cc_tabs stays an ARRAY of entry objects (older panels read exactly that), and every entry a window writes is
//    stamped with that window's id (`win`), the time of the write (`at`) and, for its active tab, `active: true`.
//    The entries of one `win` are a GROUP. An entry without `win` was written by an older panel (or by a window
//    without Web Locks, the fallback): all of those together count as one group, the legacy group.
//  · A window owns its group and only its group. Writing replaces the own group and passes every other entry
//    through untouched — read → merge → write under the lock `cc_tabs`, so two windows cannot interleave it.
//  · Presence is a Web Lock per window (`ccui-win-<id>`), held for the life of the document. A lock falls only
//    with the document, so a busy or frozen window is never taken for dead — the 150-ms BroadcastChannel round of
//    the first draft could not promise that. `navigator.locks.query()` lists who is alive.
//  · The id lives in sessionStorage: it survives a reload (and a session restore) of THIS window and nothing
//    else. „Duplicate tab" copies sessionStorage — then the id is still held by the original, and the copy takes
//    a new one (twReclaim).
//  · Boot (twPick): a window restores its OWN group. A reload without one restores nothing. A NEW window (no id of
//    its own, or a duplicate) restores an orphaned group only when no other panel window is alive — the first
//    window after a crash or a browser restart takes the youngest orphaned group; a second window starts EMPTY
//    (Julian's decision) and never shows another window's tabs.
//  · Entries are passed through as OBJECTS: merge, pick and retag only add or overwrite win/at/active and never
//    rebuild an entry, so a field a later version adds (projectId, feat/projekte) survives every write of a window
//    that does not know it.
//  · Orphaned groups are bounded (twMerge): age, count and size, oldest first — a full localStorage throws on
//    setItem, and that used to switch the whole tab persistence off without a word.
//  · A draft rides in its tab's entry. A tab WITHOUT a session has no entry, so the draft of a window that restores
//    no tab comes from that window's sessionStorage on a reload, and from the global cc_draft only for the first
//    window after a restart (twBootDraft) — the global key is whatever any window typed last.

var TW_LOCK_PREFIX = 'ccui-win-';   // + window id: held by that window for as long as its document lives
var TW_STORE_LOCK = 'cc_tabs';       // read → merge → write of cc_tabs, one window at a time
var TW_SESSION_KEY = 'ccui-win';     // sessionStorage: this window's id, kept across its reloads
// sessionStorage: the composer draft of THIS window (commands.js saveDraft writes it next to the global cc_draft).
// A tab without a session has no cc_tabs entry to carry its draft, and the global key holds whatever ANY window
// typed last — a reload of A showed B's text there.
var TW_DRAFT_KEY = 'ccui-draft';
var TW_GLOBAL_DRAFT_KEY = 'cc_draft'; // localStorage: the last draft typed in any window (as before part B)
// How long a window whose id is still held waits for that lock to fall before it calls itself a duplicate. On a
// reload the old document's lock is released when the document goes, and that release and the new document's
// request travel separately — reasoned, not measured; a real duplicate (the original keeps the lock) costs this
// much delay before it shows its empty tab.
var TW_GRACE_MS = 1000;
var TW_POLL_MS = 50;
var TW_ORPHAN_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // an orphaned group nobody adopted in 30 days goes
var TW_MAX_ORPHAN_GROUPS = 4;                     // …and only the youngest four are kept at all
// Upper bound for the whole serialized list, in characters, before orphaned groups are dropped (oldest first).
// localStorage has ~5 MB per origin and other keys live there too; a group of ten tabs with full drafts is well
// under 100 000. Reasoned, not measured — the real backstop is the retry without orphans in chat.js tabsWrite.
var TW_MAX_CHARS = 800000;
var TW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function twNewId() {
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
// an entry is any plain object — its content is the panel's business (restoreTabs), not this file's
function twIsEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e);
}
// '' = the legacy group (no window id)
function twGroupKey(e) {
  return (typeof e.win === 'string' && TW_ID_RE.test(e.win)) ? e.win : '';
}
// the groups of a stored list, in the order they first appear; `at` = the newest write stamp in the group (0 if
// none — a legacy group has none and sorts as the oldest)
function twGroups(list) {
  var by = {}, out = [];
  (Array.isArray(list) ? list : []).forEach(function (e, i) {
    if (!twIsEntry(e)) return;
    var k = twGroupKey(e);
    var g = by[k];
    if (!g) { g = by[k] = { win: k, at: 0, first: i, entries: [] }; out.push(g); }
    g.entries.push(e);
    var at = Number(e.at);
    if (isFinite(at) && at > g.at) g.at = at;
  });
  return out;
}
function twChars(entries) {
  try { return JSON.stringify(entries).length; } catch (e) { return Infinity; }
}

// What this window writes: its own entries (`mine`, freshly built from its tabs) stamped, then every other group
// as it was stored. Groups of LIVE windows (`alive`, from twAlive) are never dropped — their window rewrites them
// itself, and dropping one would cost it its tabs on its next reload. Orphaned groups (window gone, or legacy) are
// bounded: older than maxAgeMs, beyond the youngest maxOrphanGroups, or while the whole list is over maxChars —
// always the oldest first. `alive` null = nobody could say who lives: then nothing foreign is judged or dropped.
// → { list, dropped } (dropped = number of orphaned groups left out)
function twMerge(stored, mine, o) {
  o = o || {};
  var win = o.win, now = Number(o.now) || 0;
  var maxGroups = o.maxOrphanGroups != null ? o.maxOrphanGroups : TW_MAX_ORPHAN_GROUPS;
  var maxChars = o.maxChars != null ? o.maxChars : TW_MAX_CHARS;
  var maxAge = o.maxAgeMs != null ? o.maxAgeMs : TW_ORPHAN_MAX_AGE_MS;
  var alive = Array.isArray(o.alive) ? o.alive : null;
  var marked = false;
  var own = (Array.isArray(mine) ? mine : []).filter(twIsEntry).map(function (e) {
    var c = Object.assign({}, e);
    c.win = win; c.at = now;
    if (!marked && o.active && c.sessionId === o.active) { c.active = true; marked = true; } else delete c.active;
    return c;
  });
  var foreign = twGroups(stored).filter(function (g) { return g.win !== win; });
  var keep = foreign;
  var dropped = 0;
  if (alive) {
    var orphans = foreign.filter(function (g) { return !g.win || alive.indexOf(g.win) < 0; });
    var young = orphans.filter(function (g) { return !(g.at > 0 && now - g.at > maxAge); });
    // youngest first; a tie keeps the stored order (the later writer stands earlier — own entries go first)
    young.sort(function (a, b) { return (b.at - a.at) || (a.first - b.first); });
    young = young.slice(0, Math.max(0, maxGroups));
    var size = function () {
      var all = own.slice();
      foreign.forEach(function (g) { if (orphans.indexOf(g) < 0 || young.indexOf(g) >= 0) all = all.concat(g.entries); });
      return twChars(all);
    };
    while (young.length && size() > maxChars) young.pop();
    keep = foreign.filter(function (g) { return orphans.indexOf(g) < 0 || young.indexOf(g) >= 0; });
    dropped = foreign.length - keep.length;
  }
  var out = own;
  keep.forEach(function (g) { out = out.concat(g.entries); });
  return { list: out, dropped: dropped };
}

// What a booting window restores. `win` = its id, `others` = the ids of the OTHER live windows (twAlive minus its
// own; null = could not be asked), `kind` = twReclaim's verdict. → { entries, group, own }
//  · its own group, if it has one (a reload, a session restore of this window);
//  · a RELOAD without one: nothing. It is this window coming back, not a first window — the window had no tab to
//    keep, and adopting here handed it the tabs of a window the user had just closed (and resumed one of them),
//    or took a group from under a window that is about to come back with its own sessionStorage (a session
//    restore, „reopen closed tab"); the group stays for a window that really is a first one;
//  · else, only if no other window is alive: the youngest other group — the first window after a crash or a
//    restart adopts what the last one left (the legacy group counts as one group, as the oldest);
//  · else nothing: a second window starts empty and never shows a live window's tabs.
function twPick(stored, o) {
  o = o || {};
  var gs = twGroups(stored);
  var own = null;
  gs.forEach(function (g) { if (g.win && g.win === o.win) own = g; });
  if (own && own.entries.length) return { entries: own.entries.slice(), group: own.win, own: true };
  var none = { entries: [], group: null, own: false };
  if (o.kind === 'reload') return none;
  if (!Array.isArray(o.others) || o.others.length) return none;
  var best = null;
  gs.forEach(function (g) { if (g.win !== o.win && (!best || g.at > best.at)) best = g; });
  return best ? { entries: best.entries.slice(), group: best.win, own: false } : none;
}

// Move the entries of group `from` ('' = the legacy group) to window `to` — adopting an orphaned group, or (to a
// fresh id that no window holds) leaving the own group behind as an orphan for a later window.
function twRetag(stored, from, to) {
  return (Array.isArray(stored) ? stored : []).filter(twIsEntry).map(function (e) {
    if (twGroupKey(e) !== from) return e;
    var c = Object.assign({}, e); c.win = to; return c;
  });
}

// The session the restore activates. A stamped group carries it in `active`; a legacy group has only the old
// global cc_tabs_active (`legacyActive`), which every window overwrites — so it is read for a legacy group only.
function twActiveSession(entries, legacyActive) {
  var list = (Array.isArray(entries) ? entries : []).filter(twIsEntry);
  var stamped = list.some(function (e) { return !!twGroupKey(e); });
  if (!stamped) return legacyActive || null;
  for (var i = 0; i < list.length; i++) if (list[i].active === true && list[i].sessionId) return list[i].sessionId;
  return null;
}

// The draft a window that restored NO tab puts into its composer (`session` = its sessionStorage, `local` =
// localStorage; `kind` from twReclaim, `others` = the other live windows, null = could not be asked) → string:
//  · a reload: its own (TW_DRAFT_KEY) — never the global one, which another window may have typed last;
//  · the first window after a restart (nobody else alive): the global one, as before part B — whoever typed last
//    is gone, and that text is all there is;
//  · anything else (a second window, a duplicate next to its original, nobody to ask): nothing. A duplicate's
//    sessionStorage is a copy of the original's, so its „own" draft is the original's — chat.js tabsBoot replaces
//    that copy with what the duplicate's composer holds, or its first reload (kind 'reload') read it here.
function twBootDraft(o) {
  var read = function (store, key) { try { var v = store && store.getItem(key); return typeof v === 'string' ? v : ''; } catch (e) { return ''; } };
  if (o.kind === 'reload') return read(o.session, TW_DRAFT_KEY);
  if (Array.isArray(o.others) && !o.others.length) return read(o.local, TW_GLOBAL_DRAFT_KEY);
  return '';
}

// Hold the window lock of `id` for the life of the document, if nobody holds it. → Promise<release fn | null>.
// The release is for the test suite; the page never lets go (the lock falls with the document).
function twHold(locks, id) {
  return new Promise(function (resolve, reject) {
    var release; var held = new Promise(function (r) { release = r; });
    try {
      locks.request(TW_LOCK_PREFIX + id, { ifAvailable: true }, function (lock) {
        if (!lock) { resolve(null); return null; }
        resolve(function () { release(); });
        return held;
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}
// The ids of every window that holds its lock right now. → Promise<string[] | null> (null = the query failed)
function twAlive(locks) {
  return Promise.resolve().then(function () { return locks.query(); }).then(function (q) {
    var ids = [];
    ((q && q.held) || []).forEach(function (l) {
      var n = l && typeof l.name === 'string' ? l.name : '';
      if (n.indexOf(TW_LOCK_PREFIX) === 0 && ids.indexOf(n.slice(TW_LOCK_PREFIX.length)) < 0) ids.push(n.slice(TW_LOCK_PREFIX.length));
    });
    return ids;
  }, function () { return null; });
}
function twRemember(session, id) {
  try { session.setItem(TW_SESSION_KEY, id); } catch (e) { /* the id then lives for this document only */ }
}
// Take back the id this window had before (sessionStorage). → Promise<{ win, kind, release }>
//  · kind 'reload'    — the id was there and its lock is free (or fell within graceMs): a reload, a session restore
//  · kind 'fresh'     — no id stored: a new window (win null; the caller takes a new id under the cc_tabs lock)
//  · kind 'duplicate' — the id is held by a live window the whole grace time: „Duplicate tab" copied sessionStorage
//    (win null, as fresh)
// A fresh window takes its id only under the cc_tabs lock (chat.js tabsBoot), AFTER it decided what to restore:
// two fresh windows booting at the same moment then do not both see the other alive, and the first one adopts.
function twReclaim(o) {
  var graceMs = o.graceMs != null ? o.graceMs : TW_GRACE_MS, pollMs = o.pollMs || TW_POLL_MS;
  var prev = null;
  try { prev = o.session.getItem(TW_SESSION_KEY); } catch (e) { prev = null; }
  if (typeof prev !== 'string' || !TW_ID_RE.test(prev)) return Promise.resolve({ win: null, kind: 'fresh', release: null });
  var waited = 0;
  var attempt = function () {
    return twHold(o.locks, prev).then(function (release) {
      if (release) return { win: prev, kind: 'reload', release: release };
      if (waited >= graceMs) return { win: null, kind: 'duplicate', release: null };
      waited += pollMs;
      return new Promise(function (r) { o.setTimeout(r, pollMs); }).then(attempt);
    });
  };
  return attempt();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    twNewId, twIsEntry, twGroupKey, twGroups, twChars, twMerge, twPick, twRetag, twActiveSession, twBootDraft,
    twHold, twAlive, twRemember, twReclaim,
    TW_LOCK_PREFIX, TW_STORE_LOCK, TW_SESSION_KEY, TW_DRAFT_KEY, TW_GLOBAL_DRAFT_KEY, TW_GRACE_MS, TW_POLL_MS, TW_ORPHAN_MAX_AGE_MS,
    TW_MAX_ORPHAN_GROUPS, TW_MAX_CHARS, TW_ID_RE,
  };
}
