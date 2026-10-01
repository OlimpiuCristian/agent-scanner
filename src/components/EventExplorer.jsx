import React, { useEffect, useMemo, useRef, useState } from 'react';
import { styleOf } from '../kinds.js';
import { EVENT_FILTERS, eventExcerpt, searchEvents } from '../eventSearch.js';

const PAGE_SIZE = 60;

export default function EventExplorer({ events, nodes, cursor, onSeek, open, onClose }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const wasOpen = useRef(open);
  const index = Math.floor(cursor);
  const matches = useMemo(() => searchEvents(events, nodes, query, filter), [events, nodes, query, filter]);
  const labels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);
  const errorCount = useMemo(() => events.filter((event) => event.kind === 'error').length, [events]);
  const currentMatch = matches.findIndex((match) => match.index === index);
  const previous = matches.findLast((match) => match.index < index);
  const next = matches.find((match) => match.index > index);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const start = visiblePage * PAGE_SIZE;
  const rows = matches.slice(start, start + PAGE_SIZE);

  // Keep playback and external timeline jumps visible, including across pages.
  useEffect(() => {
    if (currentMatch >= 0) setPage(Math.floor(currentMatch / PAGE_SIZE));
  }, [index, currentMatch, open]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = list?.querySelector('[aria-current="true"]');
    if (row) {
      const top = row.offsetTop;
      if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2);
      }
    }
  }, [index, visiblePage, currentMatch, open]);

  useEffect(() => {
    if (open && !wasOpen.current) inputRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const reset = () => { setQuery(''); setFilter('all'); setPage(0); };
  const filtered = query.trim() || filter !== 'all';

  return (
    <aside id="event-explorer" className="event-explorer" aria-label="Session events" hidden={!open}>
      <div className="ee-heading">
        <div><h3>Session events</h3><p>Find a moment. Jump to its place in the graph.</p></div>
        <button onClick={onClose} aria-label="Close event explorer" title="Close event explorer">×</button>
      </div>
      <div className="ee-search">
        <input ref={inputRef} type="search" aria-label="Search session events" placeholder="Search messages, tools, agents…"
          value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
      </div>
      <div className="ee-filters" role="group" aria-label="Filter events">
        {EVENT_FILTERS.map((item) => (
          <button key={item.id} className={'chip' + (filter === item.id ? ' on' : '')}
            aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setPage(0); }}>
            {item.label}{item.id === 'errors' && <span className="ee-error-count">{' '}{errorCount}</span>}
          </button>
        ))}
      </div>
      <div className="ee-results">
        <span role="status">{matches.length} {filtered ? 'matches' : 'events'}{filtered ? ` / ${events.length}` : ''}</span>
        <div>
          <button aria-label="Previous matching event" title="Previous matching event" disabled={!previous} onClick={() => onSeek(previous.index)}>↑</button>
          <button aria-label="Next matching event" title="Next matching event" disabled={!next} onClick={() => onSeek(next.index)}>↓</button>
        </div>
      </div>
      <div className="ee-list" ref={listRef}>
        {rows.map(({ event, index: eventIndex }) => {
          const style = styleOf(event.kind);
          return (
            <button key={eventIndex} className={'ee-event' + (eventIndex === index ? ' selected' : '')}
              aria-current={eventIndex === index ? 'true' : undefined} onClick={() => onSeek(eventIndex)}>
              <span className="ee-meta"><span>#{eventIndex + 1}</span><span className="kindtag" style={{ color: style.color, borderColor: style.color }}>{style.label}</span>
                <time>{event.ts ? new Date(event.ts).toLocaleTimeString([], { hour12: false }) : '—'}</time></span>
              <span className="ee-route"><Highlight text={`${labels.get(event.from) || event.from} → ${labels.get(event.to) || event.to}`} query={query} /></span>
              {event.tool && <span className="ee-tool"><Highlight text={event.tool} query={query} /></span>}
              <span className="ee-excerpt"><Highlight text={eventExcerpt(event, query)} query={query} /></span>
            </button>
          );
        })}
        {!matches.length && <div className="ee-empty">
          <strong>{events.length ? 'No matching events' : 'No events yet'}</strong>
          <p>{events.length ? 'Try a different phrase or include all event types.' : 'Events will appear here when the session has activity.'}</p>
          {filtered && <button onClick={reset}>Clear filters</button>}
        </div>}
      </div>
      {matches.length > PAGE_SIZE && <div className="ee-pages">
        <button aria-label="Previous results page" disabled={visiblePage === 0} onClick={() => { setPage(visiblePage - 1); listRef.current.scrollTop = 0; }}>←</button>
        <span>{start + 1}–{Math.min(start + PAGE_SIZE, matches.length)} of {matches.length}</span>
        <button aria-label="Next results page" disabled={visiblePage === lastPage} onClick={() => { setPage(visiblePage + 1); listRef.current.scrollTop = 0; }}>→</button>
      </div>}
      <div className="ee-hint">Selecting an event pauses playback and Follow latest.</div>
    </aside>
  );
}

function Highlight({ text, query }) {
  const needle = query.trim();
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}
