/** Codex CLI adapter: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GraphBuilder, classifyTool, clip, baseName } from '../common.js';
import { readJsonl } from '../jsonl.js';

export const id = 'codex';
export const label = 'Codex';
export const color = '#10a37f';

export function defaultRoots() {
  return [path.join(os.homedir(), '.codex', 'sessions')];
}

const TOOL_MAP = {
  shell_command: 'shell', exec_command: 'shell', exec: 'shell', run: 'shell',
  write_stdin: 'shell', wait: 'shell',
  apply_patch: 'fs', view_image: 'fs', read_file: 'fs', write_file: 'fs',
  update_plan: 'control',
  web_search: 'web',
  get_goal: 'control', create_goal: 'control', update_goal: 'control',
};

/* Titles live separately, in ~/.codex/session_index.jsonl */
let titleCache = null;
async function threadNames(root) {
  if (titleCache) return titleCache;
  titleCache = new Map();
  // session_index.jsonl sits next to the sessions/ folder
  const candidates = [
    path.join(path.dirname(root), 'session_index.jsonl'),
    path.join(os.homedir(), '.codex', 'session_index.jsonl'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      await readJsonl(f, (o) => {
        if (o?.id && o?.thread_name) titleCache.set(o.id, o.thread_name);
      });
      break;
    } catch { /* ignore */ }
  }
  return titleCache;
}

function argsOf(payload) {
  const raw = payload.arguments ?? payload.input;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function summarize(name, a, payload) {
  if (name === 'shell_command' || name === 'exec_command' || name === 'exec' || name === 'run') {
    const c = a.command ?? a.cmd ?? a._raw;
    return clip(Array.isArray(c) ? c.join(' ') : String(c || ''), 90);
  }
  if (name === 'apply_patch') {
    const txt = String(payload.input || a._raw || '');
    const m = txt.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
    return m ? 'patch ' + baseName(m[1].trim()) : 'apply_patch';
  }
  if (name === 'update_plan') return 'update plan';
  if (name === 'view_image') return 'image ' + baseName(a.path || '');
  return name + (a.query ? ': ' + clip(a.query, 60) : '');
}

export async function index(file) {
  let sessionId = null, cwd = null, first = null, last = null;
  let msgs = 0, tools = 0, model = null;

  await readJsonl(file, (o) => {
    const ts = o.timestamp;
    if (ts) { if (!first) first = ts; last = ts; }
    const p = o.payload || {};
    if (o.type === 'session_meta') { sessionId = p.id || sessionId; cwd = p.cwd || cwd; }
    if (o.type === 'turn_context' && p.model) model = p.model;
    if (o.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) msgs++;
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) tools++;
  });

  if (!msgs && !tools) return null;
  const names = await threadNames(path.resolve(file, '..', '..', '..', '..'));
  const fallback = path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  return {
    sessionId: sessionId || fallback,
    title: (sessionId && names.get(sessionId)) || fallback.slice(0, 19).replace('T', ' '),
    project: cwd ? cwd.replace(/\\/g, '/') : 'unknown',
    start: first, end: last, messages: msgs, tools, subagents: [], model,
  };
}

export async function parse(file) {
  const g = new GraphBuilder();
  let sessionId = null, cwd = null, lastTs = null;

  await readJsonl(file, (o) => {
    const ts = o.timestamp || lastTs;
    if (o.timestamp) lastTs = o.timestamp;
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      sessionId = p.id || sessionId;
      cwd = p.cwd || cwd;
      if (p.model_provider) g.models.add(p.model_provider);
      return;
    }

    if (o.type === 'turn_context') {
      if (p.model) { g.models.clear(); g.models.add(p.model); }
      if (p.cwd) cwd = p.cwd;
      return;
    }

    if (o.type === 'event_msg') {
      // human messages and final answers; the remaining events are telemetry
      if (p.type === 'user_message' && p.message) g.prompt({ ts, text: stripEnvBlock(p.message) });
      else if (p.type === 'agent_message' && p.message) g.reply({ ts, text: p.message });
      else if (p.type === 'agent_reasoning' && p.text) g.think({ ts, text: p.text });
      else if (p.type === 'web_search_end') {
        const q = p.query || p.action?.query || '';
        const id = 'ws' + g.seq;
        g.call({ ts, capability: 'web', tool: 'web_search', callId: id, label: 'search: ' + clip(q, 70), detail: clip(q, 800) });
        g.result({ ts, callId: id, text: clip(JSON.stringify(p), 1500) });
      } else if (p.type === 'error' && p.message) {
        g.push({ ts, actor: 'orchestrator', from: 'orchestrator', to: 'orchestrator', kind: 'error', label: clip(p.message, 100), detail: clip(p.message, 1500) });
      }
      return;
    }

    if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const a = argsOf(p);
        g.call({
          ts, capability: classifyTool(p.name, TOOL_MAP), tool: p.name, callId: p.call_id,
          label: summarize(p.name, a, p),
          detail: clip(typeof p.input === 'string' ? p.input : JSON.stringify(a, null, 2), 3000),
        });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        g.result({ ts, callId: p.call_id, text: out, isError: /"exit_code":\s*[1-9]|^Exit code: [1-9]/.test(out || '') });
      }
    }
  });

  const names = await threadNames(path.resolve(file, '..', '..', '..', '..'));
  const fallback = path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  return g.finish({
    sessionId: sessionId || fallback,
    source: id, file,
    title: (sessionId && names.get(sessionId)) || fallback.slice(0, 19).replace('T', ' '),
    cwd,
    project: cwd ? cwd.replace(/\\/g, '/') : 'unknown',
  });
}

// the first message contains an <environment_context> block injected by the CLI
function stripEnvBlock(s) {
  return String(s).replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim() || String(s);
}
