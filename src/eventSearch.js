import { styleOf } from './kinds.js';

export const EVENT_FILTERS = [
  { id: 'all', label: 'All events' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'errors', label: 'Errors' },
];

// Keep the original array index: the graph and timeline always use the full session.
export function searchEvents(events, nodes, query = '', filter = 'all') {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const needle = query.trim().toLowerCase();
  return events.flatMap((event, index) => {
    if (filter === 'conversation' && !styleOf(event.kind).agent) return [];
    if (filter === 'errors' && event.kind !== 'error') return [];
    const fields = [event.label, event.detail, event.tool, styleOf(event.kind).label,
      labels.get(event.from), labels.get(event.to)];
    if (needle && !fields.some((field) => String(field || '').toLowerCase().includes(needle))) return [];
    return [{ event, index }];
  });
}

export function eventExcerpt(event, query = '') {
  const text = String(event.detail || event.label || '').replace(/\s+/g, ' ').trim();
  const needle = query.trim().toLowerCase();
  const match = needle ? text.toLowerCase().indexOf(needle) : -1;
  const start = Math.max(0, match - 45);
  const length = Math.max(160, needle.length + 90);
  return (start ? '…' : '') + text.slice(start, start + length) + (text.length > start + length ? '…' : '');
}
