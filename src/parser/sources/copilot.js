/**
 * GitHub Copilot Chat adapter (VS Code).
 *   %APPDATA%/Code/User/workspaceStorage/<ws>/chatSessions/<id>.json   full snapshot
 *   ...                                        /chatSessions/<id>.jsonl  change journal
 * In the journal, kind 0 = initial state, kind 1 = set path k to v, kind 2 = append to k.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GraphBuilder, classifyTool, clip, baseName } from '../common.js';
import { readTail } from '../jsonl.js';

export const id = 'copilot';
export const label = 'Copilot';
export const color = '#6e40c9';

export function defaultRoots() {
  const app = process.env.APPDATA;
  return app ? [path.join(app, 'Code', 'User', 'workspaceStorage')] : [];
}

/** Above this size we refuse to load, so the server never stalls. */
const MAX_BYTES = 260 * 1024 * 1024;

const TOOL_MAP = {
  run_in_terminal: 'shell', runTests: 'shell', getTerminalOutput: 'shell',
  manage_todo_list: 'control', runSubagent: 'control',
  fetch_webpage: 'web', vscode_searchExtensions_internal: 'control',
};

/* ---------- reading ---------- */

function applyPath(obj, keys, value, append) {
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null) o[k] = typeof keys[i + 1] === 'number' ? [] : {};
    o = o[k];
  }
  const last = keys[keys.length - 1];
  if (append) {
    if (!Array.isArray(o[last])) o[last] = [];
    // kind 2 sends a batch of items, which get concatenated (not nested)
    if (Array.isArray(value)) for (const x of value) o[last].push(x);
    else o[last].push(value);
  } else {
    o[last] = value;
  }
}

/** Rebuilds the session from a .jsonl journal. */
function replayJournal(file) {
  let state = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.kind === 0) state = o.v ?? {};
    else if (o.kind === 1 && Array.isArray(o.k)) applyPath(state, o.k, o.v, false);
    else if (o.kind === 2 && Array.isArray(o.k)) applyPath(state, o.k, o.v, true);
  }
  return state;
}

function load(file) {
  const { size } = fs.statSync(file);
  if (size > MAX_BYTES) {
    throw new Error(`session too large (${Math.round(size / 1048576)} MB) — not loading it, to keep the server responsive`);
  }
  return file.endsWith('.jsonl') ? replayJournal(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ---------- index ---------- */

/** Top-level keys come after `requests`, so they are read from the file's tail. */
async function tailMeta(file) {
  const tail = await readTail(file, 96 * 1024);
  const grab = (k, num) => {
    const re = new RegExp('"' + k + '":\\s*' + (num ? '([0-9]{10,16})' : '"((?:[^"\\\\]|\\\\.){0,200})"'), 'g');
    let m, last = null;
    while ((m = re.exec(tail))) last = m[1];
    return last;
  };
  return {
    customTitle: grab('customTitle'),
    creationDate: Number(grab('creationDate', true)) || null,
    lastMessageDate: Number(grab('lastMessageDate', true)) || null,
  };
}

const NEEDLES = {
  requests: Buffer.from('"requestId":'),
  tools: Buffer.from('"kind":"toolInvocationSerialized"'),
  subagents: Buffer.from('"toolId":"runSubagent"'),
};
const OVERLAP = 40; // longest needle, so a match split across reads still counts

/** Counts matches whose START index is below `limit`, so no match is counted twice. */
function countIn(buf, limit, needle) {
  let n = 0, i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1 && i < limit) { n++; i += needle.length; }
  return n;
}

/**
 * Counts requests and tools without parsing the whole file.
 * Searches the raw Buffer: decoding each chunk to a string and running three
 * global regexes over it was the single slowest step of the whole index.
 */
function scanCounts(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK + OVERLAP);
  const out = { requests: 0, tools: 0, subagents: 0 };
  try {
    let pos = 0, carried = 0, n;
    while ((n = fs.readSync(fd, buf, carried, CHUNK, pos)) > 0) {
      pos += n;
      const end = carried + n;
      // on the last chunk count to the very end; otherwise stop short of the
      // tail we are about to carry, so a straddling match is counted exactly once
      const limit = pos >= size ? end : Math.max(0, end - OVERLAP);
      const view = buf.subarray(0, end);
      for (const k of Object.keys(NEEDLES)) out[k] += countIn(view, limit, NEEDLES[k]);
      carried = end - limit;
      buf.copy(buf, 0, limit, end);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

export async function index(file) {
  const st = fs.statSync(file);
  const meta = await tailMeta(file);
  const c = scanCounts(file);
  if (!c.requests) return null;

  const ws = path.basename(path.dirname(path.dirname(file)));
  return {
    sessionId: path.basename(file).replace(/\.jsonl?$/, ''),
    title: meta.customTitle || 'chat ' + path.basename(file).slice(0, 8),
    project: 'workspace ' + ws.slice(0, 8),
    start: meta.creationDate ? new Date(meta.creationDate).toISOString() : null,
    end: meta.lastMessageDate ? new Date(meta.lastMessageDate).toISOString() : new Date(st.mtimeMs).toISOString(),
    messages: c.requests * 2,
    tools: c.tools,
    subagents: c.subagents ? ['runSubagent'] : [],
    big: st.size > MAX_BYTES,
  };
}

/* ---------- parsing ---------- */

const textOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.value || '' : '');

function toolLabel(part) {
  const inv = textOf(part.invocationMessage) || textOf(part.pastTenseMessage);
  const clean = inv.replace(/^Using\s+"|"$/g, '').trim();
  const d = part.toolSpecificData || {};
  if (d.commandLine?.original) return clip(d.commandLine.original, 90);
  if (d.command) return clip(String(d.command), 90);
  if (part.toolId === 'runSubagent') return clean || 'sub-agent';
  return clean || part.toolId || 'tool';
}

export async function parse(file) {
  const d = load(file);
  const g = new GraphBuilder();
  const requests = Array.isArray(d.requests) ? d.requests : [];

  for (const r of requests) {
    const ts = r.timestamp ? new Date(r.timestamp).toISOString() : null;
    if (r.modelId) g.models.add(String(r.modelId).replace(/^copilot\//, ''));

    const prompt = textOf(r.message?.text) || textOf(r.message);
    if (prompt.trim()) g.prompt({ ts, text: prompt });

    let textBuf = '';
    for (const part of r.response || []) {
      if (!part || typeof part !== 'object') continue;

      if (!part.kind && part.value != null) { textBuf += textOf(part.value); continue; }
      if (part.kind === 'thinking') { g.think({ ts, text: textOf(part.value) }); continue; }

      if (part.kind === 'textEditGroup') {
        const f = part.uri?.fsPath || part.uri?.path || '';
        const cid = 'edit' + g.seq;
        g.call({ ts, capability: 'fs', tool: 'textEdit', callId: cid, label: 'edit ' + baseName(f), detail: f });
        g.result({ ts, callId: cid, text: 'edits applied to ' + f });
        continue;
      }

      if (part.kind === 'toolInvocationSerialized') {
        const tool = part.toolId || 'tool';
        const cid = part.toolCallId || 't' + g.seq;
        const lbl = toolLabel(part);

        if (tool === 'runSubagent') {
          const target = g.subagent(lbl.slice(0, 40) || 'sub-agent');
          g.delegate({ ts, target, callId: cid, label: lbl, detail: clip(JSON.stringify(part.toolSpecificData || {}, null, 2), 2000) });
        } else {
          g.call({
            ts, capability: classifyTool(tool, TOOL_MAP), tool, callId: cid,
            label: lbl, detail: clip(JSON.stringify(part.toolSpecificData || part.invocationMessage || {}, null, 2), 2000),
          });
        }
        const out = textOf(part.pastTenseMessage) || (part.isComplete ? 'done' : 'in progress');
        g.result({ ts, callId: cid, text: out, isError: part.isComplete === false });
      }
    }

    if (textBuf.trim()) g.reply({ ts, text: textBuf });
  }

  const ws = path.basename(path.dirname(path.dirname(file)));
  return g.finish({
    sessionId: d.sessionId || path.basename(file).replace(/\.jsonl?$/, ''),
    source: id, file,
    title: d.customTitle || 'chat ' + path.basename(file).slice(0, 8),
    cwd: null,
    project: 'workspace ' + ws.slice(0, 8),
  });
}
