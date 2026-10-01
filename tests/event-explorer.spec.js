import { test, expect } from '@playwright/test';

const nodes = [
  { id: 'user', label: 'You (User)', type: 'agent', kind: 'user', color: '#22e06a' },
  { id: 'orchestrator', label: 'Main Agent', type: 'agent', kind: 'orchestrator', color: '#e0a020' },
  { id: 'orchestrator::shell', label: 'Shell', type: 'capability', kind: 'capability', owner: 'orchestrator', capability: 'shell', color: '#4aa3ff' },
];

function fixture() {
  const events = Array.from({ length: 135 }, (_, i) => ({
    i, ts: new Date(Date.UTC(2026, 9, 2, 10, 0, i)).toISOString(),
    kind: 'call', actor: 'orchestrator', from: 'orchestrator', to: 'orchestrator::shell',
    tool: 'exec_command', label: `Check ${i + 1}`, detail: `Checking project file ${i + 1}`,
  }));
  events[0] = { ...events[0], kind: 'prompt', from: 'user', to: 'orchestrator', actor: 'user', tool: null, detail: 'Investigate the failing deployment' };
  events[12] = { ...events[12], kind: 'error', from: 'orchestrator::shell', to: 'orchestrator', detail: 'Diagnostic output. '.repeat(30) + 'ECONNREFUSED: database unavailable' };
  events[73] = { ...events[73], kind: 'error', from: 'orchestrator::shell', to: 'orchestrator', detail: 'Connection timeout while retrying database' };
  events[130] = { ...events[130], kind: 'reply', to: 'user', tool: null, detail: 'Deployment fixed. The database is now reachable.' };
  const graph = { title: 'Investigate deployment failure', nodes, events };
  const sessions = [
    { file: '/fixtures/demo.jsonl', sessionId: 'demo', title: graph.title, source: 'codex', sourceLabel: 'Codex', project: 'demo/app', messages: 135, mtime: 1 },
    { file: '/fixtures/empty.jsonl', sessionId: 'empty', title: 'Empty session', source: 'codex', sourceLabel: 'Codex', project: 'demo/app', messages: 0, mtime: 1 },
  ];
  return { graph, sessions };
}

async function openFixture(page) {
  const data = fixture();
  await page.addInitScript(() => {
    localStorage.setItem('agentviz.roots', JSON.stringify(['/fixtures']));
    // Emit live notifications deterministically without watching any personal folders.
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.testLiveSource = this; }
      close() {}
    };
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const responses = {
      '/api/roots': { roots: [] },
      '/api/sessions': { sessions: data.sessions, fingerprint: String(data.graph.events.length) },
      '/api/pulse': { fingerprint: String(data.graph.events.length) },
      '/api/session': url.searchParams.get('file')?.includes('empty') ? { title: 'Empty session', nodes, events: [] } : data.graph,
    };
    await route.fulfill({ json: responses[url.pathname] || {} });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: data.graph.title })).toBeVisible();
  await expect(page.locator('.ee-event')).toHaveCount(60);
  return data;
}

test('searches deep message content and jumps to the original timeline position', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: '▶ Run', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search session events' }).fill('econnrefused');
  await expect(page.getByRole('status')).toHaveText('1 matches / 135');
  await expect(page.locator('.ee-event mark')).toHaveText('ECONNREFUSED');
  await page.locator('.ee-event').click();
  await expect(page.locator('.tl-time')).toContainText('13 / 135');
  await expect(page.locator('.mb-body')).toContainText('database unavailable');
  await expect(page.getByRole('checkbox', { name: 'Follow latest' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Live', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '▶ Run', exact: true })).toBeVisible();
});

test('combines error filters with search, navigates matches and resets empty results', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'Errors 2' }).click();
  await expect(page.locator('.ee-event')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next matching event' }).click();
  await expect(page.locator('.tl-time')).toContainText('13 / 135');
  await expect(page.getByRole('button', { name: 'Previous matching event' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next matching event' }).click();
  await expect(page.locator('.tl-time')).toContainText('74 / 135');
  await expect(page.getByRole('button', { name: 'Next matching event' })).toBeDisabled();
  await page.getByRole('searchbox').fill(' timeout ');
  await expect(page.getByRole('status')).toHaveText('1 matches / 135');
  await page.getByRole('searchbox').fill('[no match].*');
  await expect(page.getByText('No matching events')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('status')).toHaveText('135 events');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('.ee-event')).toHaveCount(2);
  await expect(page.locator('.ee-event').last()).toContainText('Deployment fixed');
});

test('searches tool and agent names, limits DOM rows and tracks keyboard timeline jumps across pages', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('searchbox').fill('exec_command');
  await expect(page.getByRole('status')).toHaveText('133 matches / 135');
  await page.getByRole('searchbox').fill('Main Agent');
  await expect(page.getByRole('status')).toHaveText('135 matches / 135');
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Next results page' }).click();
  await expect(page.locator('.ee-pages')).toContainText('61–120 of 135');
  await page.locator('.ee-event').last().click();
  await page.locator('.header h2').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tl-time')).toContainText('121 / 135');
  await expect(page.locator('.ee-pages')).toContainText('121–135 of 135');
  await expect(page.locator('.ee-event')).toHaveCount(15);
  await expect(page.locator('.ee-event[aria-current="true"]')).toContainText('#121');
});

test('keyboard selection works, collapse preserves filters and changing sessions resets them', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('searchbox').fill('timeout');
  await page.locator('.ee-event').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.tl-time')).toContainText('74 / 135');
  await expect(page.getByRole('button', { name: '▶ Run', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close event explorer' }).click();
  await expect(page.getByRole('button', { name: 'Events 135', exact: true })).toBeFocused();
  await expect(page.locator('#event-explorer')).toBeHidden();
  await page.getByRole('button', { name: 'Events 135', exact: true }).click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('timeout');
  await page.locator('.session').filter({ hasText: 'Empty session' }).click();
  await expect(page.getByText('No events yet')).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveValue('');
});

test('live refresh retains a selected result, while Follow latest still follows new events', async ({ page }) => {
  const data = await openFixture(page);
  await page.getByRole('searchbox').fill('timeout');
  await page.locator('.ee-event').click();
  const append = async () => {
    const i = data.graph.events.length;
    data.graph.events.push({ ...data.graph.events[73], i, detail: 'Connection timeout on latest retry' });
    data.sessions[0].mtime++;
    await page.evaluate(() => window.testLiveSource.dispatchEvent(new Event('change')));
  };
  await append();
  await expect(page.getByRole('status')).toHaveText('2 matches / 136');
  await expect(page.locator('.tl-time')).toContainText('74 / 136');
  await page.getByRole('checkbox', { name: 'Follow latest' }).check();
  await append();
  await expect(page.locator('.tl-time')).toContainText('137 / 137');
  await expect(page.locator('.ee-event[aria-current="true"]')).toContainText('#137');
});

test('keeps results and playback controls usable at desktop and compact sizes', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openFixture(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 640 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Errors 2' }).click();
    await page.locator('.ee-event').last().click();
    await expect(page.locator('.mb-body')).toContainText('Connection timeout');
    const bounds = await page.locator('.ee-list').boundingBox();
    expect(bounds.height).toBeGreaterThan(100);
    const message = await page.locator('.mb-body').boundingBox();
    const workspace = await page.locator('.session-workspace').boundingBox();
    expect(message.height).toBe(96);
    expect(message.y + message.height).toBeLessThanOrEqual(workspace.y);
    const timeline = await page.locator('.timeline').boundingBox();
    expect(timeline.y + timeline.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`events-${viewport.width}.png`) });
  }
  await page.getByRole('button', { name: 'Close event explorer' }).click();
  await expect(page.locator('.stage')).toBeVisible();
  expect(errors).toEqual([]);
});
