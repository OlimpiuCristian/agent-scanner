/**
 * Event types.
 * `agent: true` marks real agent-to-agent communication; the rest are tool executions.
 */
export const KIND_STYLE = {
  prompt: { color: '#22e06a', label: 'prompt', agent: true },
  reply: { color: '#8fe3ff', label: 'reply', agent: true },
  delegate: { color: '#ff5c7a', label: 'delegate', agent: true },
  message: { color: '#ff8fa8', label: 'agent message', agent: true },
  report: { color: '#ffb3c4', label: 'agent report', agent: true },
  ask: { color: '#ffd24a', label: 'ask human', agent: true },
  call: { color: '#4aa3ff', label: 'tool call' },
  result: { color: '#5c7a99', label: 'tool result' },
  error: { color: '#ff4d4d', label: 'error' },
  think: { color: '#6b5cff', label: 'thinking' },
};

export const styleOf = (kind) => KIND_STYLE[kind] || KIND_STYLE.call;
