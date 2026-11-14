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
    ]);
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);
    expect(screen.getByText('4 nodes · 3 relations · 2 skipped')).toBeTruthy();
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
    expect(dimmedTitles()).toEqual(['CLM - It does not']);
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
    for (let step = 0; step < 3; step += 1) {
      fireEvent.keyDown(surface(), { key: 'Tab' });
      seen.add(selectedTitle());
    }
    // Four presses of Tab visit all four nodes on show, once each.
    expect(seen.size).toBe(4);
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
    ).toEqual(['Question1', 'Claim2', 'Evidence1']);
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
    expect(nodeTitles().length).toBe(4);
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
    // What a canvas holds that is not drawn is listed under Issues, not said for good.
    expect(status()).toBe('Double-click a node, or press Enter, to open its note.');
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
    expect(nodeTitles().length).toBe(4);
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

interface View {
  x: number;
  y: number;
  k: number;
}

/** Where the drawing sits in the pane, read back from the group that moves it. */
function viewOf(): View {
  const text = surface().querySelector('svg > g')?.getAttribute('transform') ?? '';
  const found = /translate\((\S+) (\S+)\) scale\((\S+)\)/.exec(text);
  return { x: Number(found?.[1]), y: Number(found?.[2]), k: Number(found?.[3]) };
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box around every node on show, in the pane's own pixels. */
function drawnEdges(): Edges {
  const view = viewOf();
  const boxes = [...surface().querySelectorAll('.graph-node-box')].map((box) => ({
    x: Number(box.getAttribute('x')),
    y: Number(box.getAttribute('y')),
    w: Number(box.getAttribute('width')),
    h: Number(box.getAttribute('height')),
  }));
  return {
    left: Math.min(...boxes.map((box) => box.x)) * view.k + view.x,
    top: Math.min(...boxes.map((box) => box.y)) * view.k + view.y,
    right: Math.max(...boxes.map((box) => box.x + box.w)) * view.k + view.x,
    bottom: Math.max(...boxes.map((box) => box.y + box.h)) * view.k + view.y,
  };
}

function placeOf(title: string): string {
  const box = node(title).querySelector('.graph-node-box');
  return `${box?.getAttribute('x') ?? ''},${box?.getAttribute('y') ?? ''}`;
}

function readout(): HTMLElement | null {
  return screen.queryByLabelText('Node under the pointer');
}

function toggle(name: RegExp): HTMLElement {
  return within(screen.getByRole('group', { name: 'Lists and filters' })).getByRole('button', {
    name,
  });
}

describe('nodes with no relations', () => {
  it('are left out until asked for, and counted on the button that shows them', async () => {
    renderPane();
    await findGraph();

    const unlinked = toggle(/^Unlinked/);
    expect(unlinked.textContent).toBe('Unlinked (1)');
    expect(unlinked.getAttribute('aria-pressed')).toBe('false');
    expect(nodeTitles()).not.toContain('CLM - Alone');

    fireEvent.click(unlinked);
    expect(unlinked.getAttribute('aria-pressed')).toBe('true');
    expect(nodeTitles()).toContain('CLM - Alone');
    expect(screen.getByText('5 nodes · 3 relations · 2 skipped')).toBeTruthy();
    // Showing them moves none of the others.
    fireEvent.click(unlinked);
    expect(nodeTitles().length).toBe(4);
  });

  it('are all drawn in a vault that has no relations, with nothing to toggle', async () => {
    vault.graph = { ...GRAPH, relations: [] };
    renderPane();
    await findGraph();

    expect(nodeTitles().length).toBe(5);
    expect(screen.queryByRole('button', { name: /^Unlinked/ })).toBeNull();
  });

  it('does not offer the toggle on a canvas, which is drawn as saved', async () => {
    renderPane({ view: 'Overview' });
    await findGraph();
    expect(screen.queryByRole('button', { name: /^Unlinked/ })).toBeNull();
  });
});

describe('reading a node', () => {
  it('draws the type as a chip and the rest of the title as the text', async () => {
    renderPane();
    await findGraph();

    const claim = node('CLM - It scales');
    expect(within(claim).getByText('CLM')).toBeTruthy();
    expect(within(claim).getByText('It scales')).toBeTruthy();
    expect([...claim.querySelectorAll('text')].map((text) => text.textContent)).toEqual([
      'CLM',
      'It scales',
    ]);
    // The whole title is still there for a pointer that rests on the box.
    expect(claim.querySelector('title')?.textContent).toBe('CLM - It scales');
  });

  it('draws boxes without text when zoomed far out, and labels again when zoomed back', async () => {
    renderPane();
    await findGraph();
    expect(surface().getAttribute('data-detail')).toBe('text');

    fireEvent.wheel(surface(), { deltaY: 800, clientX: 0, clientY: 0 });
    // At about a third of full size the text would be under 5 px tall. The
    // type's short name alone still fits the box, drawn large.
    expect(viewOf().k).toBeLessThan(0.4);
    expect(surface().getAttribute('data-detail')).toBe('codes');
    const texts = () =>
      [...node('CLM - It scales').querySelectorAll('text')].map((text) => text.textContent);
    expect(texts()).toEqual(['CLM']);
    expect(within(surface()).queryByText('supports')).toBeNull();

    // Further out there is no room for that either: coloured boxes only.
    fireEvent.wheel(surface(), { deltaY: 800, clientX: 0, clientY: 0 });
    expect(viewOf().k).toBeLessThan(0.15);
    expect(surface().getAttribute('data-detail')).toBe('boxes');
    expect(texts()).toEqual([]);
    // The boxes and the lines are all still there, and still pick out a node.
    expect(nodeTitles().length).toBe(4);
    expect(edgeIds()).toEqual(['r1', 'r2', 'r3']);

    fireEvent.wheel(surface(), { deltaY: -1600, clientX: 0, clientY: 0 });
    expect(within(node('CLM - It scales')).getByText('It scales')).toBeTruthy();
    expect(within(surface()).getAllByText('supports').length).toBe(2);
  });

  it('spells out the node under the pointer below the drawing', async () => {
    renderPane();
    await findGraph();
    expect(readout()).toBeNull();

    fireEvent.pointerOver(node('CLM - It scales'));
    const strip = readout();
    expect(strip?.textContent).toBe('ClaimCLM - It scalessupported by 1 · supports 1');
    // The status line gives way, and comes back when the pointer moves off.
    expect(screen.getByRole('status').getAttribute('data-covered')).toBe('true');

    fireEvent.pointerOver(surface());
    expect(readout()).toBeNull();
    expect(screen.getByRole('status').getAttribute('data-covered')).toBe('false');
  });

  it('spells out the selected node when the pointer is on none', async () => {
    renderPane();
    await findGraph();

    fireEvent.keyDown(surface(), { key: 'Tab' });
    const first = selectedTitle() ?? '';
    expect(readout()?.textContent).toContain(first);

    // The pointer wins while it rests on another node.
    fireEvent.pointerOver(node('CLM - It does not'));
    expect(readout()?.textContent).toBe('ClaimCLM - It does notopposes 1');
    fireEvent.pointerLeave(surface());
    expect(readout()?.textContent).toContain(first);
  });

  it('shows a label that has no room only while its node is selected', async () => {
    // One claim and the question it supports end up side by side, a narrow gap apart.
    vault.graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.slice(0, 2),
      relations: GRAPH.relations.slice(0, 1),
    };
    renderPane();
    await findGraph();
    expect(edgeIds()).toEqual(['r1']);
    expect(within(surface()).queryByText('supports')).toBeNull();

    fireEvent.click(node('CLM - It scales'));
    expect(within(surface()).getByText('supports')).toBeTruthy();
    fireEvent.keyDown(surface(), { key: 'Escape' });
    expect(within(surface()).queryByText('supports')).toBeNull();
  });

  it('colours each line by what the relation says', async () => {
    renderPane();
    await findGraph();

    const line = (id: string) => surface().querySelector(`[data-edge-id="${id}"]`);
    expect(line('r1')?.getAttribute('data-kind')).toBe('supports');
    expect(line('r1')?.querySelector('path')?.getAttribute('stroke')).toBe('#40c057');
    expect(line('r2')?.getAttribute('data-kind')).toBe('opposes');
    expect(line('r2')?.querySelector('path')?.getAttribute('stroke')).toBe('#ff6b6b');
    // Each label sits on a background of its own, drawn after the boxes.
    const label = surface().querySelector('[data-label-for="r1"]');
    expect(label?.querySelector('rect')).not.toBeNull();
    const order = [...surface().querySelectorAll('.graph-node, .graph-edge-label')].map((item) =>
      item.getAttribute('class'),
    );
    expect(order.indexOf('graph-edge-label')).toBeGreaterThan(order.lastIndexOf('graph-node'));
  });
});

describe('fitting the pane', () => {
  let pane = { w: 0, h: 0 };
  let resized: (() => void)[] = [];

  function resizeTo(w: number, h: number) {
    pane = { w, h };
    act(() => {
      for (const notify of resized) {
        notify();
      }
    });
  }

  /** The drawing's own width: a list beside it takes 300 from the pane's. */
  function drawingWidth(): number {
    return document.querySelector('.graph-panel') === null ? pane.w : pane.w - 300;
  }

  function expectFitted() {
    const edges = drawnEdges();
    const width = drawingWidth();
    // A margin of 14 on every side, and the drawing reaches it on one axis at least.
    expect(edges.left).toBeGreaterThanOrEqual(13.9);
    expect(edges.top).toBeGreaterThanOrEqual(13.9);
    expect(edges.right).toBeLessThanOrEqual(width - 13.9);
    expect(edges.bottom).toBeLessThanOrEqual(pane.h - 13.9);
    const spare = Math.min(edges.left - 14, edges.top - 14);
    expect(spare < 0.5 || viewOf().k === 1.25).toBe(true);
    // And it sits in the middle.
    expect(edges.left).toBeCloseTo(width - edges.right, 3);
    expect(edges.top).toBeCloseTo(pane.h - edges.bottom, 3);
  }

  beforeEach(() => {
    pane = { w: 690, h: 220 };
    resized = [];
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function width(
      this: HTMLElement,
    ) {
      return this.classList.contains('graph-surface') ? drawingWidth() : pane.w;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => pane.h);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly notify: () => void;
        constructor(notify: () => void) {
          this.notify = notify;
        }
        observe() {
          resized.push(this.notify);
        }
        disconnect() {
          resized = resized.filter((item) => item !== this.notify);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fills a small pane with the drawing, leaving a small margin', async () => {
    renderPane();
    await findGraph();
    // The pane is measured, the graph laid out for its shape, and then fitted.
    await waitFor(expectFitted);
  });

  it('fits again when the pane changes size', async () => {
    renderPane();
    await findGraph();
    const before = viewOf();

    resizeTo(400, 600);
    expect(viewOf()).not.toEqual(before);
    expectFitted();

    resizeTo(1200, 300);
    expectFitted();
  });

  it('fits again when what is drawn changes', async () => {
    renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Unlinked/));
    expect(nodeTitles().length).toBe(5);
    expectFitted();
  });

  it('makes room for a list by fitting again, without moving any node', async () => {
    // Wide enough that the drawing alone, beside a list, is another shape altogether.
    pane = { w: 1000, h: 300 };
    renderPane();
    await findGraph();
    await waitFor(expectFitted);
    const titles = nodeTitles();
    const before = titles.map(placeOf);
    const scale = viewOf().k;

    fireEvent.click(toggle(/^Claims/));
    resizeTo(1000, 300);
    expect(drawingWidth()).toBe(700);
    expectFitted();
    expect(viewOf().k).toBeLessThan(scale);
    expect(titles.map(placeOf)).toEqual(before);
  });

  it('leaves the view alone on a resize once it has been moved by hand, until Fit', async () => {
    renderPane();
    await findGraph();

    fireEvent.wheel(surface(), { deltaY: -200, clientX: 100, clientY: 100 });
    const moved = viewOf();
    resizeTo(400, 600);
    expect(viewOf()).toEqual(moved);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expectFitted();
    resizeTo(900, 500);
    expectFitted();
  });

  it('fits again on the F key after a drag', async () => {
    renderPane();
    await findGraph();

    fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 90, clientY: 70 });
    fireEvent.pointerUp(surface(), { pointerId: 1, clientX: 90, clientY: 70 });
    resizeTo(500, 500);
    fireEvent.keyDown(surface(), { key: 'f' });
    expectFitted();
  });
});

describe('the issues list', () => {
  it('keeps what the vault leaves out behind a button, not in the status line', async () => {
    vault.graph = {
      ...GRAPH,
      warnings: ['18 notes share an instance id with an earlier note'],
    };
    renderPane();
    await findGraph();

    expect(status()).toBe('Double-click a node, or press Enter, to open its note.');
    const issues = toggle(/^Issues/);
    expect(issues.textContent).toBe('Issues (6)');
    expect(screen.queryByRole('region', { name: 'Issues' })).toBeNull();

    fireEvent.click(issues);
    const list = screen.getByRole('region', { name: 'Issues' });
    expect(
      within(list)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual([
      'Relations left out2',
      'Relations that may be drawn to the wrong note1',
      'Canvas boxes whose note is missing1',
      'Canvas shapes not drawn2',
    ]);
    expect(
      within(list).getByText('Relation r8: supports, from "CLM - It scales" to unknown id id-gone'),
    ).toBeTruthy();
    expect(within(list).getByText('"CLM - Deleted since" on Overview / Detail')).toBeTruthy();

    fireEvent.click(issues);
    expect(screen.queryByRole('region', { name: 'Issues' })).toBeNull();
  });

  it('opens the note a row is about', async () => {
    const { actions } = renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Issues/));
    const list = screen.getByRole('region', { name: 'Issues' });
    // Only the rows about a note can be pressed.
    expect(within(list).getAllByRole('button').length).toBe(1);
    fireEvent.click(
      within(list).getByRole('button', {
        name: 'supports: "EVD - Benchmark run" to "CLM - It scales"',
      }),
    );
    expect(actions.openPane).toHaveBeenCalledWith({
      type: 'editor',
      path: `${VAULT}/claims/CLM - It scales.md`,
    });
  });

  it('says so when nothing is wrong', async () => {
    vault.graph = {
      ...GRAPH,
      relations: GRAPH.relations.slice(0, 2),
      skippedRelations: 0,
      issues: [],
      canvases: [],
    };
    renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Issues \(0\)/));
    expect(screen.getByText('Nothing was left out and nothing looks wrong.')).toBeTruthy();
  });
});

describe('the claims list', () => {
  function claims(): HTMLElement {
    return screen.getByRole('region', { name: 'Claims' });
  }

  function claimRow(title: string): HTMLElement {
    return within(claims()).getByRole('button', { name: new RegExp(`^${title}, `) });
  }

  it('lists every claim with what backs it, the unsupported first', async () => {
    renderPane();
    await findGraph();
    expect(screen.queryByRole('region', { name: 'Claims' })).toBeNull();

    fireEvent.click(toggle(/^Claims/));
    expect(
      within(claims()).getByText('3 claims: 2 unsupported, 0 contested, 1 supported'),
    ).toBeTruthy();
    expect(
      within(claims())
        .getAllByRole('button', { name: /supporting/ })
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual([
      'CLM - Alone, unsupported, 0 supporting, 0 opposing',
      'CLM - It does not, unsupported, 0 supporting, 0 opposing',
      'CLM - It scales, supported, 1 supporting, 0 opposing',
    ]);
    // The type is a chip, and the row's text starts at the claim itself.
    expect(within(claimRow('CLM - It scales')).getByText('CLM')).toBeTruthy();
    expect(within(claimRow('CLM - It scales')).getByText('It scales')).toBeTruthy();
  });

  it('marks each claim in the drawing by how well it is backed', async () => {
    renderPane();
    await findGraph();
    expect(node('CLM - It scales').getAttribute('data-lens')).toBeNull();

    fireEvent.click(toggle(/^Claims/));
    expect(node('CLM - It scales').getAttribute('data-lens')).toBe('supported');
    expect(node('CLM - It does not').getAttribute('data-lens')).toBe('unsupported');
    // Not claims, so not marked.
    expect(node('QUE - Does it scale').getAttribute('data-lens')).toBeNull();
    expect(node('EVD - Benchmark run').getAttribute('data-lens')).toBeNull();

    fireEvent.click(toggle(/^Claims/));
    expect(node('CLM - It does not').getAttribute('data-lens')).toBeNull();
  });

  it('marks a claim that is both supported and opposed with a split edge', async () => {
    vault.graph = {
      ...GRAPH,
      relations: [
        ...GRAPH.relations,
        {
          id: 'r4',
          typeId: 'relation_o',
          source: 'id-e',
          destination: 'id-c1',
          ambiguous: false,
          tentative: null,
        },
      ],
    };
    renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Claims/));
    const contested = node('CLM - It scales');
    expect(contested.getAttribute('data-lens')).toBe('contested');
    expect(contested.querySelector('.graph-lens-for')).not.toBeNull();
    expect(contested.querySelector('.graph-lens-against')).not.toBeNull();
    expect(
      within(claims()).getByText('3 claims: 2 unsupported, 1 contested, 0 supported'),
    ).toBeTruthy();
  });

  it('selects a claim in the drawing on a click, and opens its note on Enter or a double click', async () => {
    const { actions } = renderPane();
    await findGraph();
    fireEvent.click(toggle(/^Claims/));

    fireEvent.click(claimRow('CLM - It does not'));
    expect(selectedTitle()).toBe('CLM - It does not');
    expect(claimRow('CLM - It does not').getAttribute('aria-pressed')).toBe('true');
    expect(actions.openPane).not.toHaveBeenCalled();

    fireEvent.keyDown(claimRow('CLM - It scales'), { key: 'Enter' });
    expect(actions.openPane).toHaveBeenLastCalledWith({
      type: 'editor',
      path: `${VAULT}/claims/CLM - It scales.md`,
    });
    fireEvent.doubleClick(claimRow('CLM - It does not'));
    expect(actions.openPane).toHaveBeenLastCalledWith({
      type: 'editor',
      path: `${VAULT}/claims/CLM - It does not.md`,
    });
  });

  it('shows a hidden claim before selecting it', async () => {
    renderPane();
    await findGraph();
    fireEvent.click(toggle(/^Claims/));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Node types' })).getByRole('button', {
        name: /Claim/,
      }),
    );
    expect(nodeTitles()).not.toContain('CLM - It scales');

    // Its type was hidden, and this one has no relations as well.
    fireEvent.click(claimRow('CLM - Alone'));
    expect(selectedTitle()).toBe('CLM - Alone');
    expect(toggle(/^Unlinked/).getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the evidence for a claim on demand, and finds it in the drawing', async () => {
    renderPane();
    await findGraph();
    fireEvent.click(toggle(/^Claims/));

    const more = within(claims()).getByRole('button', { name: 'Evidence for CLM - It scales' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(within(claims()).queryByText('EVD - Benchmark run')).toBeNull();
    // A claim with nothing for or against it has nothing to open.
    expect(
      within(claims()).getByRole('button', { name: 'Evidence for CLM - Alone' }),
    ).toHaveProperty('disabled', true);

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const evidence = within(claims()).getByRole('list', { name: 'Supports CLM - It scales' });
    fireEvent.click(within(evidence).getByRole('button', { name: 'EVD - Benchmark run' }));
    expect(selectedTitle()).toBe('EVD - Benchmark run');
  });

  it('brings the chosen claim to the middle of the pane', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    renderPane();
    await findGraph();
    fireEvent.click(toggle(/^Claims/));

    fireEvent.click(claimRow('CLM - It does not'));
    const view = viewOf();
    const box = node('CLM - It does not').querySelector('.graph-node-box');
    const middleX = (Number(box?.getAttribute('x')) + 176 / 2) * view.k + view.x;
    const middleY = (Number(box?.getAttribute('y')) + 60 / 2) * view.k + view.y;
    expect(middleX).toBeCloseTo(400, 3);
    expect(middleY).toBeCloseTo(200, 3);
    width.mockRestore();
    height.mockRestore();
  });

  it('marks the claims on a canvas too, and says when one is not on it', async () => {
    renderPane({ view: 'Overview' });
    await findGraph();
    fireEvent.click(toggle(/^Claims/));

    expect(node('CLM - It scales').getAttribute('data-lens')).toBe('supported');
    fireEvent.click(claimRow('CLM - It scales'));
    expect(selectedTitle()).toBe('CLM - It scales');

    fireEvent.click(claimRow('CLM - It does not'));
    expect(status()).toBe('"CLM - It does not" is not on this canvas. All nodes shows it.');
    expect(selectedTitle()).toBe('CLM - It scales');
  });
});

describe('the candidates list', () => {
  it('lists the tagged lines by node type and opens the note of one', async () => {
    const { actions } = renderPane();
    await findGraph();

    const button = toggle(/^Candidates/);
    expect(button.textContent).toBe('Candidates (2)');
    fireEvent.click(button);

    const list = screen.getByRole('region', { name: 'Candidates' });
    expect(within(list).getByText('2 candidates: lines tagged to become nodes')).toBeTruthy();
    expect(
      within(list)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Question1#que-candidate', 'Claim1#clm-candidate']);
    expect(within(list).getByText('Monday, line 3')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: /Caching helps/ }));
    expect(actions.openPane).toHaveBeenCalledWith({
      type: 'editor',
      path: `${VAULT}/daily/Monday.md`,
    });
  });

  it('says so when the vault has none', async () => {
    vault.graph = { ...GRAPH, candidates: [] };
    renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Candidates \(0\)/));
    expect(screen.getByText('No lines in this vault carry a candidate tag.')).toBeTruthy();
  });

  it('shows one list at a time', async () => {
    renderPane();
    await findGraph();

    fireEvent.click(toggle(/^Candidates/));
    fireEvent.click(toggle(/^Claims/));
    expect(screen.queryByRole('region', { name: 'Candidates' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Claims' })).toBeTruthy();
    expect(toggle(/^Candidates/).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('a vault that changes while it is on show', () => {
  const FRESH: VaultGraph = {
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
  const SHOWN = [
    'QUE - Does it scale',
    'CLM - It scales',
    'CLM - It does not',
    'EVD - Benchmark run',
  ];

  /** Every timer is faked here, so the page is let settle by hand. */
  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('keeps every node where it was when a node is added', async () => {
    renderPane();
    await settle();
    const before = SHOWN.map(placeOf);

    vault.graph = structuredClone(FRESH);
    vault.fingerprint = '6-bbbb';
    await settle(POLL_MS);

    expect(nodeTitles()).toContain('EVD - Fresh result');
    expect(SHOWN.map(placeOf)).toEqual(before);
    expect(placeOf('EVD - Fresh result')).not.toBe(placeOf('CLM - It does not'));
  });

  it('picks out the new node for a few seconds', async () => {
    renderPane();
    await settle();
    expect(surface().querySelector('[data-fresh]')).toBeNull();

    vault.graph = structuredClone(FRESH);
    vault.fingerprint = '6-bbbb';
    await settle(POLL_MS);

    const added = node('EVD - Fresh result');
    expect(added.getAttribute('data-fresh')).toBe('true');
    expect(added.querySelector('.graph-node-halo')).not.toBeNull();
    // Only the new one.
    expect(surface().querySelectorAll('[data-fresh]').length).toBe(1);

    await settle(4000);
    expect(node('EVD - Fresh result').getAttribute('data-fresh')).toBeNull();
  });

  it('picks out a node that has just gained its first relation', async () => {
    renderPane();
    await settle();

    vault.graph = {
      ...GRAPH,
      relations: [
        ...GRAPH.relations,
        {
          id: 'r4',
          typeId: 'rel_s',
          source: 'id-e',
          destination: `path:${VAULT}/CLM - Alone.md`,
          ambiguous: false,
          tentative: null,
        },
      ],
    };
    vault.fingerprint = '5-linked';
    const before = SHOWN.map(placeOf);
    await settle(POLL_MS);

    expect(node('CLM - Alone').getAttribute('data-fresh')).toBe('true');
    expect(SHOWN.map(placeOf)).toEqual(before);
    expect(screen.queryByRole('button', { name: /^Unlinked/ })).toBeNull();
  });

  it('draws attention to the unlinked button when a new node has no relations yet', async () => {
    renderPane();
    await settle();
    expect(toggle(/^Unlinked/).getAttribute('data-fresh')).toBeNull();

    vault.graph = { ...FRESH, relations: GRAPH.relations };
    vault.fingerprint = '6-loose';
    await settle(POLL_MS);

    expect(toggle(/^Unlinked/).textContent).toBe('Unlinked (2)');
    expect(toggle(/^Unlinked/).getAttribute('data-fresh')).toBe('true');
    expect(nodeTitles()).not.toContain('EVD - Fresh result');
  });

  it('lays the graph out afresh on the reload button', async () => {
    renderPane();
    await settle();
    vault.graph = structuredClone(FRESH);
    vault.fingerprint = '6-bbbb';
    await settle(POLL_MS);
    const grown = [...SHOWN, 'EVD - Fresh result'].map(placeOf);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await settle();
    // The same graph, placed as it would be on a first look.
    expect(nodeTitles().length).toBe(5);
    expect([...SHOWN, 'EVD - Fresh result'].map(placeOf)).not.toEqual(grown);
  });

  it('updates the lists as the vault changes', async () => {
    renderPane();
    await settle();
    fireEvent.click(toggle(/^Claims/));
    expect(node('CLM - It does not').getAttribute('data-lens')).toBe('unsupported');

    vault.graph = structuredClone(FRESH);
    vault.fingerprint = '6-bbbb';
    await settle(POLL_MS);

    expect(node('CLM - It does not').getAttribute('data-lens')).toBe('supported');
    expect(screen.getByText('3 claims: 1 unsupported, 0 contested, 2 supported')).toBeTruthy();
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
    expect(screen.getByText('5 nodes · 4 relations · 2 skipped')).toBeTruthy();

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

    expect(screen.getByText('4 nodes · 3 relations · 3 skipped')).toBeTruthy();
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
    expect(nodeTitles().length).toBe(4);
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
    expect(nodeTitles().length).toBe(4);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status()).toBe(`Showing the last graph that read cleanly. ${MISSING}`);

    vault.error = null;
    await poll();
    expect(status()).not.toContain('last graph');
    expect(nodeTitles().length).toBe(4);
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
      text: [
        '/vault',
        'view: Overview / Main',
        'nodes: 2',
        'relations: 1',
        'skipped: 1',
        'unlinked hidden: 0',
        'claims: 3 (2 unsupported, 0 contested, 1 supported)',
        'candidates: 2',
        'issues: 6',
        '- QUE - Does it scale',
        '- CLM - It scales',
        '',
      ].join('\n'),
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
