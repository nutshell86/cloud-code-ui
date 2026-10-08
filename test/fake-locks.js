'use strict';
// A Web Locks manager (navigator.locks) for SEVERAL panel windows in one process — not a test file of its own
// (no `.test.js`): test/two-windows.test.js gives every window its client view, test/tab-windows.test.js runs
// the module's lock calls against this AND against Node's real navigator.locks, so the fake cannot drift from
// the real semantics on the calls public/js/tab-windows.js makes (exclusive mode, ifAvailable, query).
//
// What a real browser has and Node's real one cannot give a test: several CLIENTS, a client that goes away, and
// a client that is FROZEN.
//  · `drop(client)` is a window whose document is gone — closed, crashed, reloaded: every lock it held falls, its
//    queued requests vanish, and nothing it asks later is ever granted.
//  · `freeze(client)` is a window the browser froze (Edge sleeping tabs, a background tab after minutes): it runs
//    no task, so a grant it is due and the answer to a query() it asked are delivered only at `thaw(client)` —
//    but every lock it HOLDS stays held, which is the point of using locks for presence at all.
//    `freezeAfterGrant(client, name)` freezes it the moment a grant of `name` has run its callback, i.e. between
//    two tasks of that callback — the one spot where a frozen window can sit on a lock it was only meant to hold
//    for a moment.
// Grants and query answers are asynchronous (a microtask), as in the real API — a callback never runs inside
// request(). A lock is released when the callback's promise settles; that is the lock manager's side and does not
// wait for a frozen client (in a browser the release of a synchronous callback goes out in the same task).
function makeLocks() {
  const held = new Map();      // name → { client }
  const pending = [];          // queued exclusive requests, in arrival order
  const dead = new Set();
  const frozen = new Map();    // client → [deliveries waiting for thaw]
  const freezeOn = new Map();  // client → lock name whose grant freezes it
  const later = (fn) => { Promise.resolve().then(fn); };
  // a delivery to `client` (a grant's callback, a query's answer): now, or at thaw if it is frozen
  const deliver = (client, fn) => later(() => { if (dead.has(client)) return; if (frozen.has(client)) frozen.get(client).push(fn); else fn(); });
  function release(name, client) {
    const h = held.get(name);
    if (h && h.client === client) { held.delete(name); pump(name); }
  }
  function grant(p) {
    held.set(p.name, { client: p.client });
    deliver(p.client, () => {
      let r;
      try { r = p.cb({ name: p.name, mode: 'exclusive' }); } catch (e) { release(p.name, p.client); p.reject(e); return; }
      if (freezeOn.get(p.client) === p.name) { freezeOn.delete(p.client); freeze(p.client); }
      Promise.resolve(r).then((v) => { release(p.name, p.client); p.resolve(v); }, (e) => { release(p.name, p.client); p.reject(e); });
    });
  }
  function pump(name) {
    if (held.has(name)) return;
    const i = pending.findIndex((p) => p.name === name);
    if (i >= 0) grant(pending.splice(i, 1)[0]);
  }
  function client(id) {
    return {
      request(name, a, b) {
        const opts = typeof a === 'function' ? {} : (a || {});
        const cb = typeof a === 'function' ? a : b;
        return new Promise((resolve, reject) => {
          if (dead.has(id)) return; // a gone document asks nothing
          const p = { name: String(name), client: id, cb, resolve, reject };
          if (opts.ifAvailable && (held.has(p.name) || pending.some((x) => x.name === p.name))) {
            deliver(id, () => { Promise.resolve().then(() => cb(null)).then(resolve, reject); });
            return;
          }
          pending.push(p); pump(p.name);
        });
      },
      // the snapshot is taken when asked (the browser answers at once); the page reads it when it runs again
      query() {
        const snap = {
          held: [...held].map(([name, h]) => ({ name, mode: 'exclusive', clientId: h.client })),
          pending: pending.map((p) => ({ name: p.name, mode: 'exclusive', clientId: p.client })),
        };
        return new Promise((resolve) => deliver(id, () => resolve(snap)));
      },
    };
  }
  function drop(id) {
    dead.add(id);
    frozen.delete(id);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].client === id) pending.splice(i, 1);
    for (const [name, h] of [...held]) if (h.client === id) { held.delete(name); pump(name); }
  }
  function freeze(id) { if (!frozen.has(id)) frozen.set(id, []); }
  function thaw(id) { const q = frozen.get(id) || []; frozen.delete(id); q.forEach((fn) => later(fn)); }
  return {
    client, drop, freeze, thaw,
    freezeAfterGrant: (id, name) => { freezeOn.set(id, String(name)); },
    frozen: (id) => frozen.has(id),
    holds: (id, name) => { const h = held.get(name); return !!h && h.client === id; },
    heldNames: () => [...held.keys()],
  };
}

module.exports = { makeLocks };
