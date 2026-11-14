// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphContent } from '../../workspace/model';
import type { PaneActions } from '../pane-props';

import { GRAPH, VAULT } from './fixtures';
import { GraphPane } from './graph-pane';
import type { VaultGraph } from './vault-graph';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const POLL_MS = 2500;
const MISSING = '/nope: No such file or directory (os error 2)';

interface FakeVault {
  graph: VaultGraph;
  fingerprint: string;
  /** Set to make both commands fail. */
  error: string | null;
}

let vault: FakeVault;

function fakeInvoke(command: string): Promise<unknown> {
  if (vault.error !== null) {
    return Promise.reject(vault.error);
  }
  if (command === 'graph_read') {
    return Promise.resolve(structuredClone(vault.graph));
  }
  if (command === 'graph_fingerprint') {
    return Promise.resolve(vault.fingerprint);
  }
  return Promise.resolve(null);
}

function makeActions(): PaneActions {
  return {
    openPane: vi.fn(),
    replaceContent: vi.fn(),
    setTitle: vi.fn(),
    setBadge: vi.fn(),
    close: vi.fn(),
  };
}

interface Rendered {
  actions: PaneActions;
  rerenderWith: (content: GraphContent) => void;
}

function renderPane(content: Partial<GraphContent> = {}, debug = false): Rendered {
  const actions = makeActions();

  function pane(next: GraphContent) {
    return (
      <GraphPane
        paneId="pane-1"
        name="graph"
        content={next}
        active
        debug={debug}
        actions={actions}
      />
    );
  }

  const view = render(pane({ type: 'graph', directory: VAULT, view: null, ...content }));
  return {
    actions,
    rerenderWith(next) {
      view.rerender(pane(next));
    },
  };
}

function surface(): HTMLElement {
  return screen.getByRole('group', { name: /^Graph of / });
}

function nodeTitles(): string[] {
  return within(surface())
    .getAllByRole('button')
    .map((node) => node.getAttribute('aria-label') ?? '');
}

function node(title: string): HTMLElement {
  return within(surface()).getByRole('button', { name: title });
}

function dimmedTitles(): string[] {
  return within(surface())
    .getAllByRole('button')
    .filter((item) => item.getAttribute('data-dimmed') === 'true')
    .map((item) => item.getAttribute('aria-label') ?? '');
}

function selectedTitle(): string | null {
  const pressed = within(surface())
    .queryAllByRole('button')
    .find((item) => item.getAttribute('aria-pressed') === 'true');
  return pressed?.getAttribute('aria-label') ?? null;
}

function edgeIds(): string[] {
  return [...surface().querySelectorAll('[data-edge-id]')].map(
    (edge) => edge.getAttribute('data-edge-id') ?? '',
  );
}

function calls(command: string): number {
  return vi.mocked(invoke).mock.calls.filter(([name]) => name === command).length;
}

function status(): string {
  return screen.getByRole('status').textContent;
}

async function findGraph(): Promise<void> {
  await screen.findByRole('group', { name: /^Graph of / });
}

/** Lets one poll happen, and everything it sets off settle. */
async function poll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

beforeEach(() => {
  vault = { graph: structuredClone(GRAPH), fingerprint: '5-aaaa', error: null };
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('showing a vault', () => {
  it('draws every node and relation, with the counts in the toolbar', async () => {
    renderPane();
    await findGraph();

    expect(nodeTitles()).toEqual([
      'QUE - Does it scale',
      'CLM - It scales',
      'CLM - It does not',
      'EVD - Benchmark run',
      'CLM - Alone',
    ]);
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);
    expect(screen.getByText('5 nodes · 3 relations · 2 skipped')).toBeTruthy();
    expect(screen.getByText(VAULT)).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('graph_read', { path: VAULT });
  });

  it('labels each relation and marks the uncertain ones', async () => {
    renderPane();
    await findGraph();

    expect(within(surface()).getAllByText('supports').length).toBe(2);
    expect(within(surface()).getByText('opposes')).toBeTruthy();
    const dash = (id: string) =>
      surface().querySelector(`[data-edge-id="${id}"]`)?.getAttribute('data-dash');
    expect(dash('r1')).toBe('solid');
    expect(dash('r2')).toBe('dashed');
    expect(dash('r3')).toBe('dotted');
  });

  it('offers all nodes and one view per canvas', async () => {
    renderPane();
    await findGraph();

    const select = screen.getByRole('combobox', { name: 'View' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All nodes', 'Overview']);
    expect(screen.queryByRole('combobox', { name: 'Page' })).toBeNull();
  });

  it('says so when the directory is not a Discourse Graphs vault', async () => {
    vault.graph = {
      ...GRAPH,
      message: 'No Discourse Graphs data found in /vault.',
      nodes: [],
      relations: [],
      canvases: [],
      nodeTypes: [],
      relationTypes: [],
      skippedRelations: 0,
    };
    renderPane();

    expect(await screen.findByText('No Discourse Graphs data found in /vault.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /^Graph of / })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the reason and a retry when the vault cannot be read', async () => {
    vault.error = MISSING;
    renderPane({ directory: '/nope' });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(MISSING)).toBeTruthy();

    vault.error = null;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await findGraph();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a vault when it has none, and opens the one typed in', () => {
    const { actions } = renderPane({ directory: null });

    expect(calls('graph_read')).toBe(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Vault folder' }), {
      target: { value: ' ~/notes/lab ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'graph',
      directory: '~/notes/lab',
      view: null,
    });
  });
});

describe('opening a note', () => {
  it('opens the note in an editor pane beside the graph on a double click', async () => {
    const { actions } = renderPane();
    await findGraph();

    fireEvent.doubleClick(node('CLM - It scales'));
    expect(actions.openPane).toHaveBeenCalledTimes(1);
    expect(actions.openPane).toHaveBeenCalledWith({
      type: 'editor',
      path: `${VAULT}/claims/CLM - It scales.md`,
    });
  });

  it('opens the selected note on Enter', async () => {
    const { actions } = renderPane();
    await findGraph();

    fireEvent.keyDown(surface(), { key: 'Enter' });
    expect(actions.openPane).not.toHaveBeenCalled();

    fireEvent.click(node('EVD - Benchmark run'));
    fireEvent.keyDown(surface(), { key: 'Enter' });
    expect(actions.openPane).toHaveBeenCalledWith({
      type: 'editor',
      path: `${VAULT}/EVD - Benchmark run.md`,
    });
  });

  it('opens nothing on a double click of the background', async () => {
    const { actions } = renderPane();
    await findGraph();

    fireEvent.doubleClick(surface());
    expect(actions.openPane).not.toHaveBeenCalled();
  });

  it('says so when a canvas box names a note that is not in the vault', async () => {
    const { actions } = renderPane({ view: 'Overview' });
    await findGraph();

    fireEvent.change(screen.getByRole('combobox', { name: 'Page' }), {
      target: { value: 'page:detail' },
    });
    fireEvent.doubleClick(node('CLM - Deleted since'));
    expect(actions.openPane).not.toHaveBeenCalled();
    expect(status()).toBe('No note named "CLM - Deleted since" in this vault.');
  });
});

describe('selecting', () => {
  it('highlights a node with its neighbours and dims the rest', async () => {
    renderPane();
    await findGraph();
    expect(dimmedTitles()).toEqual([]);

    fireEvent.click(node('CLM - It scales'));
    expect(selectedTitle()).toBe('CLM - It scales');
    // It supports the question, and the evidence supports it.
    expect(dimmedTitles()).toEqual(['CLM - It does not', 'CLM - Alone']);
    const dimmedEdges = [...surface().querySelectorAll('[data-edge-id][data-dimmed="true"]')].map(
      (edge) => edge.getAttribute('data-edge-id'),
    );
    expect(dimmedEdges).toEqual(['r2']);
  });

  it('clears the selection on Escape or a click on the background', async () => {
    renderPane();
    await findGraph();

    fireEvent.click(node('QUE - Does it scale'));
    fireEvent.keyDown(surface(), { key: 'Escape' });
    expect(selectedTitle()).toBeNull();
    expect(dimmedTitles()).toEqual([]);

    fireEvent.click(node('QUE - Does it scale'));
    fireEvent.click(surface());
    expect(selectedTitle()).toBeNull();
  });

  it('moves the selection with Tab and the arrow keys', async () => {
    renderPane();
    await findGraph();

    fireEvent.keyDown(surface(), { key: 'Tab' });
    const first = selectedTitle();
    expect(first).not.toBeNull();

    const seen = new Set([first]);
    for (let step = 0; step < 4; step += 1) {
      fireEvent.keyDown(surface(), { key: 'Tab' });
      seen.add(selectedTitle());
    }
    // Five presses of Tab visit all five nodes, once each.
    expect(seen.size).toBe(5);
    expect(seen.has(null)).toBe(false);

    // One more runs off the end, so the key can move on to the next control.
    expect(fireEvent.keyDown(surface(), { key: 'Tab' })).toBe(true);
    expect(selectedTitle()).toBeNull();

    fireEvent.keyDown(surface(), { key: 'Tab', shiftKey: true });
    const last = selectedTitle();
    expect(last).not.toBeNull();
    fireEvent.keyDown(surface(), { key: 'ArrowUp' });
    fireEvent.keyDown(surface(), { key: 'ArrowLeft' });
    expect(selectedTitle()).not.toBeNull();
  });

  it('ignores keys when the pane is not the active one', async () => {
    const actions = makeActions();
    render(
      <GraphPane
        paneId="pane-1"
        name="graph"
        content={{ type: 'graph', directory: VAULT, view: null }}
        active={false}
        debug={false}
        actions={actions}
      />,
    );
    await findGraph();

    fireEvent.keyDown(surface(), { key: 'Tab' });
    expect(selectedTitle()).toBeNull();
  });

  it('does not treat the end of a drag as a click', async () => {
    renderPane();
    await findGraph();

    fireEvent.click(node('QUE - Does it scale'));
    const transformBefore = surface().querySelector('svg > g')?.getAttribute('transform');

    fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(surface(), { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.click(surface());

    // The drawing moved, and the selection survived.
    expect(surface().querySelector('svg > g')?.getAttribute('transform')).not.toBe(transformBefore);
    expect(surface().querySelector('svg > g')?.getAttribute('transform')).toBe(
      'translate(50 30) scale(1)',
    );
    expect(selectedTitle()).toBe('QUE - Does it scale');
  });

  it('zooms on the wheel and fits again on the fit button', async () => {
    renderPane();
    await findGraph();

    fireEvent.wheel(surface(), { deltaY: -400, clientX: 0, clientY: 0 });
    const zoomed = surface().querySelector('svg > g')?.getAttribute('transform') ?? '';
    expect(zoomed).toMatch(/scale\(1\.8/);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    // The test DOM has no layout, so a pane has no size and fit is the plain view.
    expect(surface().querySelector('svg > g')?.getAttribute('transform')).toBe(
      'translate(0 0) scale(1)',
    );
  });
});

describe('the legend', () => {
  it('lists the node types on show with their counts', async () => {
    renderPane();
    await findGraph();

    const legend = screen.getByRole('group', { name: 'Node types' });
    expect(
      within(legend)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Question1', 'Claim3', 'Evidence1']);
  });

  it('hides a type and its relations on a click, and shows them again on the next', async () => {
    renderPane();
    await findGraph();
    const claims = within(screen.getByRole('group', { name: 'Node types' })).getByRole('button', {
      name: /Claim/,
    });
    expect(claims.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(claims);
    expect(claims.getAttribute('aria-pressed')).toBe('false');
    expect(nodeTitles()).toEqual(['QUE - Does it scale', 'EVD - Benchmark run']);
    expect(edgeIds()).toEqual([]);
    expect(screen.getByText('2 nodes · 0 relations · 2 skipped')).toBeTruthy();

    fireEvent.click(claims);
    expect(nodeTitles().length).toBe(5);
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);
  });

  it('drops the selection when its node is hidden', async () => {
    renderPane();
    await findGraph();

    fireEvent.click(node('CLM - It scales'));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Node types' })).getByRole('button', {
        name: /Claim/,
      }),
    );
    expect(selectedTitle()).toBeNull();
    expect(dimmedTitles()).toEqual([]);
  });
});

describe('switching view', () => {
  it('shows a canvas with its own boxes and arrows, and remembers the choice', async () => {
    const { actions } = renderPane();
    await findGraph();

    fireEvent.change(screen.getByRole('combobox', { name: 'View' }), {
      target: { value: 'Overview' },
    });

    expect(nodeTitles()).toEqual(['QUE - Does it scale', 'CLM - It scales']);
    expect(edgeIds()).toEqual(['shape:arrow']);
    expect(within(surface()).getByText('backs up')).toBeTruthy();
    expect(screen.getByText('2 nodes · 1 relation · 1 skipped')).toBeTruthy();
    expect(status()).toBe('2 other shapes in this canvas are not drawn');
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'graph',
      directory: VAULT,
      view: 'Overview',
    });
    // The saved position, not one this pane worked out.
    const box = node('QUE - Does it scale').querySelector('rect');
    expect(box?.getAttribute('x')).toBe('400');
    expect(box?.getAttribute('width')).toBe('400');
  });

  it('opens on the view its content names', async () => {
    const { actions } = renderPane({ view: 'Overview.md' });
    await findGraph();

    expect(nodeTitles()).toEqual(['QUE - Does it scale', 'CLM - It scales']);
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveProperty('value', 'Overview');
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('offers the pages of a canvas, starting on the first that has boxes', async () => {
    renderPane({ view: 'Overview' });
    await findGraph();

    const pages = screen.getByRole('combobox', { name: 'Page' });
    expect(
      within(pages)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Notes', 'Main', 'Detail']);
    expect(pages).toHaveProperty('value', 'page:main');

    fireEvent.change(pages, { target: { value: 'page:notes' } });
    expect(within(surface()).queryAllByRole('button')).toEqual([]);
    expect(within(surface()).getByText('Untested')).toBeTruthy();
    expect(within(surface()).getByText('claims')).toBeTruthy();
  });

  it('goes back to all nodes, clearing the selection', async () => {
    const { actions } = renderPane({ view: 'Overview' });
    await findGraph();

    fireEvent.click(node('CLM - It scales'));
    fireEvent.change(screen.getByRole('combobox', { name: 'View' }), { target: { value: 'all' } });
    expect(nodeTitles().length).toBe(5);
    expect(selectedTitle()).toBeNull();
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'graph',
      directory: VAULT,
      view: null,
    });
  });

  it('follows its content when the workspace changes the view or the vault', async () => {
    const { rerenderWith } = renderPane();
    await findGraph();

    rerenderWith({ type: 'graph', directory: VAULT, view: 'Overview' });
    expect(nodeTitles().length).toBe(2);
    expect(calls('graph_read')).toBe(1);

    vault.graph = { ...GRAPH, directory: '/other', nodes: GRAPH.nodes.slice(0, 1), relations: [] };
    rerenderWith({ type: 'graph', directory: '/other', view: null });
    await waitFor(() => {
      expect(nodeTitles()).toEqual(['QUE - Does it scale']);
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('graph_read', { path: '/other' });
  });
});

describe('keeping up with the vault', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  it('reads the graph again only when the fingerprint changes', async () => {
    renderPane();
    await findGraph();
    expect(calls('graph_read')).toBe(1);

    await poll();
    await poll();
    expect(calls('graph_fingerprint')).toBe(3);
    expect(calls('graph_read')).toBe(1);

    // A note and a relation are added on disk, as an agent in a chat pane would.
    vault.graph = {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        { id: 'id-new', typeId: 'node_e', title: 'EVD - Fresh result', path: `${VAULT}/new.md` },
      ],
      relations: [
        ...GRAPH.relations,
        {
          id: 'r4',
          typeId: 'rel_s',
          source: 'id-new',
          destination: 'id-c2',
          ambiguous: false,
          tentative: null,
        },
      ],
    };
    vault.fingerprint = '6-bbbb';
    await poll();

    expect(calls('graph_read')).toBe(2);
    expect(nodeTitles()).toContain('EVD - Fresh result');
    expect(edgeIds()).toContain('r4');
    expect(screen.getByText('6 nodes · 4 relations · 2 skipped')).toBeTruthy();

    await poll();
    expect(calls('graph_read')).toBe(2);
  });

  it('keeps the selection and the view across a refresh', async () => {
    renderPane();
    await findGraph();
    fireEvent.click(node('CLM - It scales'));
    fireEvent.wheel(surface(), { deltaY: -400, clientX: 0, clientY: 0 });
    const before = surface().querySelector('svg > g')?.getAttribute('transform');

    vault.graph = { ...GRAPH, skippedRelations: 3 };
    vault.fingerprint = '5-cccc';
    await poll();

    expect(screen.getByText('5 nodes · 3 relations · 3 skipped')).toBeTruthy();
    expect(selectedTitle()).toBe('CLM - It scales');
    expect(surface().querySelector('svg > g')?.getAttribute('transform')).toBe(before);
  });

  it('keeps the last good graph while a file is half written, then catches up', async () => {
    renderPane();
    await findGraph();

    // Another program is part way through writing the relations file.
    vault.graph = {
      ...GRAPH,
      incomplete: true,
      relations: [],
      warnings: ['relations.json is not valid JSON (line 3, column 1)'],
    };
    vault.fingerprint = '5-half';
    await poll();

    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);
    expect(nodeTitles().length).toBe(5);
    expect(status()).toBe(
      'Showing the last graph that read cleanly. relations.json is not valid JSON (line 3, column 1)',
    );

    // The fingerprint has not moved, and the pane still asks again.
    await poll();
    expect(calls('graph_read')).toBe(3);
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);

    vault.graph = { ...GRAPH, relations: GRAPH.relations.slice(0, 1) };
    await poll();
    expect(edgeIds()).toEqual(['r1']);
    expect(status()).not.toContain('last graph');
  });

  it('keeps the last graph when the vault stops answering, and recovers', async () => {
    renderPane();
    await findGraph();

    vault.error = MISSING;
    await poll();
    expect(nodeTitles().length).toBe(5);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status()).toBe(`Showing the last graph that read cleanly. ${MISSING}`);

    vault.error = null;
    await poll();
    expect(status()).not.toContain('last graph');
    expect(nodeTitles().length).toBe(5);
  });

  it('shows what it can of a vault whose first read hits a broken file', async () => {
    vault.graph = {
      ...GRAPH,
      incomplete: true,
      relations: [],
      warnings: ['relations.json is not valid JSON (line 1, column 2)'],
    };
    renderPane();
    await findGraph();

    expect(nodeTitles().length).toBe(5);
    expect(edgeIds()).toEqual([]);
    expect(status()).toBe('relations.json is not valid JSON (line 1, column 2)');

    vault.graph = structuredClone(GRAPH);
    await poll();
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);
  });

  it('reads again at once on the reload button', async () => {
    renderPane();
    await findGraph();

    vault.graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.slice(0, 2),
      relations: GRAPH.relations.slice(0, 1),
    };
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(nodeTitles().length).toBe(2);
    });
  });

  it('stops asking once the pane is closed', async () => {
    renderPane();
    await findGraph();
    cleanup();

    const asked = calls('graph_fingerprint');
    await poll();
    await poll();
    expect(calls('graph_fingerprint')).toBe(asked);
  });
});

describe('debug snapshots', () => {
  function snapshots(): unknown[] {
    return vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'debug_snapshot')
      .map(([, args]) => args);
  }

  it('writes the view, the counts and the titles on show when snapshots are on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderPane({ view: 'Overview' }, true);
    await findGraph();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(snapshots().at(-1)).toEqual({
      id: 'graph',
      text: '/vault\nview: Overview / Main\nnodes: 2\nrelations: 1\nskipped: 1\n- QUE - Does it scale\n- CLM - It scales\n',
    });
  });

  it('writes nothing when snapshots are off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderPane();
    await findGraph();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(snapshots()).toEqual([]);
  });
});
