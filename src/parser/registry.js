/**
 * Discovers sessions under a user-chosen folder and keeps them in an incremental
 * index: a file is re-read only when its mtime/size changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as claude from './sources/claude.js';
import * as codex from './sources/codex.js';
import * as copilot from './sources/copilot.js';

const SOURCES = { claude, codex, copilot };
export const SOURCE_LIST = [claude, codex, copilot].map((s) => ({ id: s.id, label: s.label, color: s.color }));

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.cache', 'Cache', 'CachedData', 'GPUCache', 'Code Cache',
  'logs', 'log', 'tmp', 'temp', '.tmp', 'attachments', 'checkpoints', 'blob_storage',
]);

const CACHE_FILE = path.join(os.tmpdir(), 'agent-viz-index-cache.json');

let cache = new Map(); // file -> {mtime,size,src,entry|null}
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = new Map(Object.entries(raw));
  } catch { cache = new Map(); }
}

/**
 * Written synchronously and only when something was actually re-read.
 * A debounced timer was wrong here: it was unref'd, so a short-lived process
 * exited before it fired and the cache was never persisted at all.
 */
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache))); } catch { /* optional */ }
}

/** Default roots, only those that exist on disk. */
export function autoRoots() {
  const out = [];
  for (const s of [claude, codex, copilot]) {
    for (const r of s.defaultRoots()) {
      if (fs.existsSync(r)) out.push({ root: r, source: s.id, label: s.label });
    }
  }
  return out;
}

/** Which source recognises the file, by path (cheap) then by content. */
async function classify(file) {
  const p = file.replace(/\\/g, '/');
  const base = path.basename(file);

  if (/\/chatSessions\//.test(p) && /\.jsonl?$/.test(base)) return 'copilot';
  if (/^rollout-.*\.jsonl$/i.test(base)) return 'codex';
  if (!base.endsWith('.jsonl')) return null;
  // sub-agent files are folded into the parent session, not listed separately
  if (/\/subagents\/agent-[^/]+\.jsonl$/.test(p)) return null;
  if (/\/\.claude\/projects\//.test(p)) return 'claude';
  return (await claude.sniff(file)) ? 'claude' : null;
}

/**
 * The four folders that actually hold agent transcripts. Reaching one of them
 * is the whole point of the scan; everything below it is then read in full.
 */
const TARGETS = new Set(['.claude', '.codex', '.copilot', 'workspacestorage']);

/**
 * Corridors: not interesting themselves, but workspaceStorage sits behind them.
 * Copilot is not in a dot-folder — it lives under
 * AppData/Roaming/Code/User/workspaceStorage — so these names must stay walkable
 * or that entire source disappears.
 */
const CORRIDORS = new Set([
  'appdata', 'roaming', 'local',
  'code', 'code - insiders', 'vscodium', 'cursor', 'windsurf', 'user',
]);

function walk(root, { maxDepth = 10, maxFiles = 40000, fast = true } = {}) {
  const files = [];
  // if the chosen folder already sits inside a target, read everything under it
  const insideTarget = root.toLowerCase().split(/[\\/]/).some((s) => TARGETS.has(s));
  const stack = [[root, 0, insideTarget]];

  while (stack.length && files.length < maxFiles) {
    const [dir, depth, free] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(e.name)) continue;
        const lower = e.name.toLowerCase();
        const isTarget = TARGETS.has(lower);
        // once inside a target, descend freely: the folders below are named by
        // hash or by date, so no name rule could match them
        if (fast && !free && !isTarget && !CORRIDORS.has(lower)) continue;
        stack.push([full, depth + 1, free || isTarget]);
      } else if (e.isFile() && /\.jsonl?$/.test(e.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * Indexes every session under `roots`.
 * @returns {{sessions:[], scanned:number, reused:number, errors:[]}}
 */
export async function buildIndex(roots, { fast = true } = {}) {
  loadCache();
  // without explicit roots nothing is scanned: choosing the folder is the user's call
  const list = roots?.length ? roots : [];
  const seen = new Set();
  const sessions = [];
  const errors = [];
  let scanned = 0, reused = 0;

  for (const root of list) {
    if (!fs.existsSync(root)) { errors.push({ root, error: 'does not exist' }); continue; }
    for (const file of walk(root, { fast })) {
      if (seen.has(file)) continue;
      seen.add(file);

      let st;
      try { st = fs.statSync(file); } catch { continue; }

      const hit = cache.get(file);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
        reused++;
        if (hit.entry) sessions.push({ ...hit.entry, file, mtime: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
        continue;
      }

      const src = await classify(file);
      if (!src) { cache.set(file, { mtime: st.mtimeMs, size: st.size, src: null, entry: null }); continue; }

      let entry = null;
      try {
        entry = await SOURCES[src].index(file);
      } catch (e) {
        errors.push({ file, error: String(e.message || e) });
      }
      scanned++;

      if (entry) {
        entry.source = src;
        entry.sourceLabel = SOURCES[src].label;
        entry.root = root;
      }
      cache.set(file, { mtime: st.mtimeMs, size: st.size, src, entry });
      if (entry) sessions.push({ ...entry, file, mtime: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
    }
  }

  if (scanned) saveCache();
  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || '') || b.mtime - a.mtime);
  return { sessions, scanned, reused, errors: errors.slice(0, 20) };
}

/** Parses a session, picking the adapter from cache or by sniffing content. */
export async function parseSession(file) {
  loadCache();
  const src = cache.get(file)?.src || (await classify(file));
  if (!src) throw new Error('unrecognised format: ' + path.basename(file));
  const data = await SOURCES[src].parse(file);
  data.sourceLabel = SOURCES[src].label;
  return data;
}

/**
 * Cheap liveness check: re-stats only the files already known from the index,
 * with no directory walking at all. Walking a home folder costs seconds, which
 * is far too slow to repeat every few seconds; this is milliseconds.
 * New files are picked up by the periodic full scan, not by this.
 */
export function pulse(roots) {
  loadCache();
  const list = roots?.length ? roots : [];
  const seen = [];
  for (const [file, v] of cache) {
    if (!v?.entry) continue;
    if (!list.some((r) => file.startsWith(r))) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    seen.push({ file, mtime: st.mtimeMs });
  }
  return seen;
}

/** Cheap fingerprint of the on-disk state, for the poller. */
export function fingerprint(sessions) {
  let h = 0;
  for (const s of sessions) {
    const v = s.file + ':' + s.mtime;
    for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
  }
  return String(h) + ':' + sessions.length;
}

/** Lists a path's subfolders, for the folder picker. */
export function browse(dir) {
  const target = dir && dir !== '~' ? dir : os.homedir();
  const abs = path.resolve(target);
  const entries = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    entries.push({ name: e.name, path: path.join(abs, e.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries };
}
