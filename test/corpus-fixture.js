'use strict';
// Builder for synthetic transcript corpora used by the corpus* suites. Mirrors the LAYOUT and the LINE
// SHAPES of a real ~/.claude/projects tree (measured on the live corpus) — never its content: no prompts,
// no answers, no real project paths.
//
// Not a *.test.js file on purpose — node --test must not pick it up as a suite.
//
// The shapes that matter, and why each one is here:
//   <project>/<uuid>.jsonl                                       a session the panel lists
//   <project>/<uuid>/subagents/agent-<hex>.jsonl                 Task subagent, parent = the DIR name
//   <project>/<uuid>/subagents/workflows/wf_<id>/agent-<hex>.jsonl  workflow agent, same parent
//   <project>/<uuid>/subagents/workflows/wf_<id>/journal.jsonl    launched/started/result — ZERO usage
//   <project>/<uuid>/workflows/wf_<id>.json                       state, with a totalTokens field that
//                                                                 LOOKS like billing and is not
//   <project>/<uuid>/subagents/**/agent-<hex>.meta.json           label sidecar, no usage
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkCorpus(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-' + label + '-'));
  const claudeDir = path.join(root, 'claude');
  const projects = path.join(claudeDir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { root, claudeDir, projects, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } } };
}

// An assistant line with usage, shaped exactly like the live corpus: message.usage on type:"assistant",
// both ephemeral cache keys present whenever a split is given.
function asst(o) {
  const u = {
    input_tokens: o.in || 0,
    output_tokens: o.out || 0,
    cache_read_input_tokens: o.cr || 0,
    cache_creation_input_tokens: (o.e5 != null || o.e1 != null) ? (o.e5 || 0) + (o.e1 || 0) : (o.cw || 0),
    service_tier: 'standard',
  };
  if (o.e5 != null || o.e1 != null) u.cache_creation = { ephemeral_5m_input_tokens: o.e5 || 0, ephemeral_1h_input_tokens: o.e1 || 0 };
  const msg = { role: 'assistant', model: o.model || 'claude-opus-5', content: [{ type: 'text', text: o.text || 'ok' }], usage: u };
  if (o.id) msg.id = o.id;
  const line = { type: 'assistant', cwd: o.cwd || 'C:\\Users\\dev\\corp', timestamp: o.ts, message: msg };
  if (o.sessionId) line.sessionId = o.sessionId;
  if (o.sidechain) line.isSidechain = true;
  if (o.agentId) line.agentId = o.agentId;
  return JSON.stringify(line);
}
function user(o) {
  const line = { type: 'user', cwd: o.cwd || 'C:\\Users\\dev\\corp', timestamp: o.ts, message: { role: 'user', content: [{ type: 'text', text: o.text || 'hallo' }] } };
  if (o.isMeta) line.isMeta = true;
  return JSON.stringify(line);
}
const summary = (text) => JSON.stringify({ type: 'summary', summary: text });
// The CLI's own cost authority, written into the transcript by the CLI itself. camelCase, and the
// modelUsage keys are FULL Bedrock ids (incl. "[1m]"), so they need bedrockBase before matching PRICING.
function costState(o) {
  return JSON.stringify({ type: 'cost-state', sessionId: o.sessionId || '', totalCostUSD: o.totalCostUSD, hasUnknownModelCost: false, startTime: o.ts || '2026-01-05T08:00:00.000Z', modelUsage: o.modelUsage });
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return file;
}
const mainPath = (c, project, id) => path.join(c.projects, project, id + '.jsonl');
const agentPath = (c, project, id, agentId) => path.join(c.projects, project, id, 'subagents', agentId + '.jsonl');
const wfAgentPath = (c, project, id, wf, agentId) => path.join(c.projects, project, id, 'subagents', 'workflows', wf, agentId + '.jsonl');
const journalPath = (c, project, id, wf) => path.join(c.projects, project, id, 'subagents', 'workflows', wf, 'journal.jsonl');
const wfStatePath = (c, project, id, wf) => path.join(c.projects, project, id, 'workflows', wf + '.json');

module.exports = { mkCorpus, asst, user, summary, costState, writeLines, mainPath, agentPath, wfAgentPath, journalPath, wfStatePath };
