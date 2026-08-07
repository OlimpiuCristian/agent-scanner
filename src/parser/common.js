/**
 * Shared vocabulary across sources (Claude, Codex, Copilot).
 *
 * The central distinction:
 *   - AGENTS = the user, the main agent, delegated sub-agents. Real communication happens between them.
 *   - CAPABILITIES = shell, filesystem, web, control, mcp, skill. These are not agents, they are
 *     things an agent executes. Every agent has its own set, so a capability node's id
 *     is "<agent>::<capability>".
 */

const CAPABILITY_META = {
  shell: { label: 'Shell', color: '#4aa3ff' },
  fs: { label: 'Filesystem', color: '#00c8c0' },
  web: { label: 'Web', color: '#c060ff' },
  skill: { label: 'Skills', color: '#ffd24a' },
  mcp: { label: 'MCP', color: '#ff9f40' },
  control: { label: 'Control', color: '#8892a4' },
};

const AGENT_META = {
  user: { label: 'You (User)', color: '#22e06a' },
  orchestrator: { label: 'Main Agent', color: '#e0a020' },
};

const SUBAGENT_COLOR = '#ff5c7a';

export function clip(s, n = 1600) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\r/g, '');
  return s.length > n ? s.slice(0, n) + '\n… (' + (s.length - n) + ' more characters)' : s;
}

export function baseName(p) {
  if (!p || typeof p !== 'string') return '';
  return p.split(/[\\/]/).pop();
}

/** Key of a capability node, bound to the agent using it. */
const capId = (owner, cap) => owner + '::' + cap;

/**
 * Builds the graph: agents, each one's capabilities, and the events between them.
 * Every event records `actor` — the agent that produced it.
 */
export class GraphBuilder {
  constructor() {
    this.events = [];
    this.agents = new Map(); // id -> {id,label,color,kind,parent}
    this.caps = new Set();   // "owner::cap"
    this.pending = new Map();
    this.models = new Set();
    this.seq = 0;
    this.addAgent('user', { label: AGENT_META.user.label, color: AGENT_META.user.color, kind: 'user' });
    this.addAgent('orchestrator', { label: AGENT_META.orchestrator.label, color: AGENT_META.orchestrator.color, kind: 'orchestrator', parent: 'user' });
  }

  addAgent(id, meta) {
    if (!this.agents.has(id)) this.agents.set(id, { id, ...meta });
    else if (meta.label && this.agents.get(id).label !== meta.label) Object.assign(this.agents.get(id), meta);
    return id;
  }

  /** Registers a sub-agent delegated by `parent`. */
  subagent(name, { parent = 'orchestrator', key = null } = {}) {
    const id = 'agent:' + (key || name || 'sub-agent');
    return this.addAgent(id, { label: name || key || 'sub-agent', color: SUBAGENT_COLOR, kind: 'subagent', parent });
  }

  /** An agent's capability node (created on first use). */
  cap(owner, cap) {
    const id = capId(owner, cap);
    this.caps.add(id);
    return id;
  }

  push(e) {
    e.i = this.seq++;
    this.events.push(e);
    return e;
  }

  prompt({ ts, text, to = 'orchestrator' }) {
    return this.push({ ts, actor: 'user', from: 'user', to, kind: 'prompt', label: clip(text.trim(), 110), detail: clip(text.trim(), 3000) });
  }

  reply({ ts, text, actor = 'orchestrator', to = 'user' }) {
    return this.push({ ts, actor, from: actor, to, kind: 'reply', label: clip(text.trim(), 110), detail: clip(text.trim(), 3000) });
  }

  think({ ts, text, actor = 'orchestrator' }) {
    return this.push({ ts, actor, from: actor, to: actor, kind: 'think', label: 'thinking…', detail: clip(text, 2500) });
  }

  /** Real delegation to another agent. */
  delegate({ ts, actor = 'orchestrator', target, label, detail, callId }) {
    if (callId) this.pending.set(callId, { node: target, summary: label, tool: 'Agent', isAgent: true });
    return this.push({ ts, actor, from: actor, to: target, kind: 'delegate', tool: 'Agent', label, detail });
  }

  /** Message from one agent to another (SendMessage). */
  message({ ts, actor, target, label, detail, callId }) {
    if (callId) this.pending.set(callId, { node: target, summary: label, tool: 'SendMessage', isAgent: true });
    return this.push({ ts, actor, from: actor, to: target, kind: 'message', tool: 'SendMessage', label, detail });
  }

  /** Agent `actor` executes something through one of its capabilities. */
  call({ ts, actor = 'orchestrator', capability, tool, label, detail, callId, kind = 'call' }) {
    const node = kind === 'ask' ? 'user' : this.cap(actor, capability);
    if (callId) this.pending.set(callId, { node, summary: label, tool });
    return this.push({ ts, actor, from: actor, to: node, kind, tool, label, detail });
  }

  /** The response returns to the agent that made the call. */
  result({ ts, actor = 'orchestrator', callId, text, isError }) {
    const p = callId ? this.pending.get(callId) : null;
    if (p && callId) this.pending.delete(callId);
    return this.push({
      ts, actor,
      from: p ? p.node : this.cap(actor, 'control'),
      to: actor,
      kind: isError ? 'error' : p?.isAgent ? 'report' : 'result',
      tool: p ? p.tool : null,
      label: p ? 'result: ' + p.summary : 'result',
      detail: clip(text, 2500),
    });
  }

  nodes() {
    const out = [];
    // the same sub-agent type can run as several instances; number them
    const seen = new Map();
    for (const a of this.agents.values()) {
      let label = a.label;
      if (a.kind === 'subagent') {
        const n = (seen.get(label) || 0) + 1;
        seen.set(label, n);
        if (n > 1) label = `${label} #${n}`;
      }
      out.push({ ...a, label, type: 'agent' });
    }
    for (const id of this.caps) {
      const [owner, cap] = id.split('::');
      const m = CAPABILITY_META[cap] || CAPABILITY_META.control;
      out.push({ id, type: 'capability', capability: cap, owner, label: m.label, color: m.color, kind: 'capability' });
    }
    const rank = (n) => (n.id === 'user' ? 0 : n.id === 'orchestrator' ? 1 : n.type === 'agent' ? 2 : 3);
    out.sort((a, b) => rank(a) - rank(b) || String(a.label).localeCompare(String(b.label)));

    if (this.models.size) {
      const on = out.find((n) => n.id === 'orchestrator');
      if (on) on.sub = [...this.models].filter((m) => m && m !== '<synthetic>').slice(0, 3).join(', ');
    }
    return out;
  }

  stats() {
    const s = {};
    for (const e of this.events) s[e.kind] = (s[e.kind] || 0) + 1;
    return s;
  }

  finish(meta) {
    // sort chronologically, so sub-agent events interleave correctly
    this.events.sort((a, b) => (a.ts || '').localeCompare(b.ts || '') || a.i - b.i);
    this.events.forEach((e, i) => (e.i = i));
    const events = this.events;
    return {
      ...meta,
      nodes: this.nodes(),
      events,
      stats: this.stats(),
      start: events.length ? events[0].ts : null,
      end: events.length ? events[events.length - 1].ts : null,
    };
  }
}

/** Generic classification of tools into capabilities. */
export function classifyTool(name, extra = {}) {
  if (extra[name]) return extra[name];
  const n = String(name || '').toLowerCase();
  if (/^mcp[_-]|^_/.test(name)) return 'mcp';
  if (/skill/.test(n)) return 'skill';
  if (/(bash|shell|powershell|terminal|exec|run_in|command|process|stdin|^wait$|runtests)/.test(n)) return 'shell';
  if (/(websearch|web_search|fetch|browser|search_web|url)/.test(n)) return 'web';
  if (/(read|write|edit|patch|file|glob|grep|dir|find|codebase|notebook|image|usages|errors|changed)/.test(n)) return 'fs';
  return 'control';
}
