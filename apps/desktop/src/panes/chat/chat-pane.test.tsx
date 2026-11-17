// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseLayout } from '../../layout/layout';
import { type ChatContent, activeTab, leavesOf } from '../../workspace/model';
import { parseWorkspace, serializeWorkspace } from '../../workspace/persist';
import { createWorkspace, defaultDraft, workspaceReducer } from '../../workspace/reducer';
import type { PaneActions } from '../pane-props';

import { ChatPane } from './chat-pane';

const tauri = vi.hoisted(() => {
  class FakeChannel {
    onmessage: (message: unknown) => void = () => undefined;
  }
  return { FakeChannel, invoke: vi.fn() };
});

vi.mock('@tauri-apps/api/core', () => ({ Channel: tauri.FakeChannel, invoke: tauri.invoke }));

const runSchema = z.object({
  id: z.string(),
  agent: z.string(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  prompt: z.string().nullable(),
  onLine: z.instanceof(tauri.FakeChannel),
  onExit: z.instanceof(tauri.FakeChannel),
});

type Run = z.infer<typeof runSchema>;

const CLAUDE_FIRST_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  'plan',
  '--disallowedTools',
  'Read(.obsidian/**)',
  'Read(**/.obsidian/**)',
];

const TRUST_KEY = 'chat.trusted-folders';
const UNTRUSTED: ChatContent = { type: 'chat', agent: null, directory: '/work/download' };

function trustQuestion(): HTMLElement | null {
  return screen.queryByRole('group', { name: 'Folder trust' });
}

function commandCalls(command: string): unknown[] {
  return tauri.invoke.mock.calls.flatMap((call: unknown[]) =>
    call[0] === command ? [call[1]] : [],
  );
}

function runs(): Run[] {
  return commandCalls('agent_run').map((payload) => runSchema.parse(payload));
}

function lastRun(): Run {
  const run = runs().at(-1);
  if (run === undefined) {
    throw new Error('agent_run was not called');
  }
  return run;
}

function feed(run: Run, ...lines: unknown[]) {
  act(() => {
    for (const line of lines) {
      run.onLine.onmessage(typeof line === 'string' ? line : JSON.stringify(line));
    }
  });
}

function exit(run: Run, exitCode: number | null = 0, stderr = '') {
  act(() => {
    run.onExit.onmessage({ exitCode, stderr });
  });
}

function delta(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
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

interface Options {
  content?: ChatContent;
  active?: boolean;
  debug?: boolean;
  actions?: PaneActions;
}

function renderPane({
  content = { type: 'chat', agent: null, directory: '/work/demo' },
  active = true,
  debug = false,
  actions = makeActions(),
}: Options = {}) {
  function element(next: Options = {}) {
    return (
      <ChatPane
        paneId="p1"
        name="chat-1"
        content={next.content ?? content}
        active={next.active ?? active}
        debug={next.debug ?? debug}
        actions={actions}
      />
    );
  }
  const view = render(element());
  return {
    actions,
    rerender: (next: Options) => {
      view.rerender(element(next));
    },
  };
}

function composer(): HTMLElement {
  return screen.getByLabelText('Message');
}

function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

function sendMessage(text: string) {
  type(text);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

/** Every chat content the pane handed to the workspace, oldest first. */
function savedContents(actions: PaneActions): ChatContent[] {
  return vi
    .mocked(actions.replaceContent)
    .mock.calls.flatMap(([content]) => (content.type === 'chat' ? [content] : []));
}

function lastSaved(actions: PaneActions): ChatContent {
  const saved = savedContents(actions).at(-1);
  if (saved === undefined) {
    throw new Error('the pane saved no content');
  }
  return saved;
}

/** The content as it comes back after the app quits and opens again. */
function afterReopen(content: ChatContent): ChatContent {
  const start = createWorkspace(defaultDraft());
  const paneId = activeTab(start)?.focusedId ?? '';
  const saved = serializeWorkspace(
    workspaceReducer(start, { type: 'replace-content', paneId, content }),
  );
  const restored = parseWorkspace(saved);
  const tab = restored === null ? null : activeTab(restored);
  const reopened = tab === null ? undefined : leavesOf(tab.root)[0]?.content;
  if (reopened === undefined || reopened.type !== 'chat') {
    throw new Error('the saved workspace did not come back with its chat');
  }
  return reopened;
}

function texts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map((node) => node.textContent);
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockResolvedValue(undefined);
  window.localStorage.clear();
  window.localStorage.setItem(TRUST_KEY, JSON.stringify(['/work/demo', '/work/v']));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatPane', () => {
  it('sends the prompt on stdin with read-only Claude arguments', () => {
    renderPane();
    sendMessage('  What is in this repo?  ');

    const run = lastRun();
    expect(run.agent).toBe('claude');
    expect(run.args).toEqual(CLAUDE_FIRST_ARGS);
    expect(run.cwd).toBe('/work/demo');
    expect(run.prompt).toBe('What is in this repo?');
    expect(run.args).not.toContain('What is in this repo?');
    expect(run.id).not.toBe('');
    expect(texts('.chat-user')).toEqual(['What is in this repo?']);
    expect(composer()).toHaveProperty('value', '');
  });

  it('streams Claude lines into one assistant message, shown once', () => {
    renderPane();
    sendMessage('hi');
    const run = lastRun();

    feed(
      run,
      { type: 'system', subtype: 'init', session_id: 's-1', model: 'm', tools: [] },
      delta('Hel'),
      delta('lo **there**'),
    );
    expect(texts('.chat-assistant')).toEqual(['Hello there']);
    expect(document.querySelector('.chat-assistant strong')?.textContent).toBe('there');

    feed(
      run,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello **there**' }] } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 't1', name: 'Read' },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/app.tsx' } },
          ],
        },
      },
      'not json at all',
      { type: 'something_new', payload: 1 },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: 's-1' },
    );
    exit(run);

    expect(texts('.chat-assistant')).toEqual(['Hello there']);
    expect(texts('.chat-tool')).toEqual(['Read src/app.tsx']);
    expect(texts('.chat-note')).toEqual(['not json at all']);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resumes the session on a follow-up message', () => {
    renderPane();
    sendMessage('first');
    const first = lastRun();
    feed(first, { type: 'system', subtype: 'init', session_id: 's-42' });
    feed(first, { type: 'result', subtype: 'success', is_error: false, session_id: 's-42' });
    exit(first);

    sendMessage('second');
    const second = lastRun();
    expect(runs()).toHaveLength(2);
    expect(second.args).toEqual([...CLAUDE_FIRST_ARGS, '--resume', 's-42']);
    expect(second.prompt).toBe('second');
    expect(second.id).not.toBe(first.id);
  });

  it('uses the chosen mode for the next message', () => {
    renderPane();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'edit' } });
    sendMessage('fix it');
    expect(lastRun().args).toContain('acceptEdits');
    expect(lastRun().args).not.toContain('plan');
  });

  it('starts in the mode its content names, and follows a change from outside', () => {
    const content: ChatContent = {
      type: 'chat',
      agent: 'claude',
      directory: '/work/v',
      mode: 'edit',
    };
    const { rerender } = renderPane({ content });
    expect(screen.getByLabelText('Mode')).toHaveProperty('value', 'edit');
    sendMessage('add a claim');
    expect(lastRun().args).toContain('acceptEdits');
    expect(lastRun().args).toContain('Bash(kd node:*)');

    rerender({ content: { ...content, mode: 'read-only' } });
    expect(screen.getByLabelText('Mode')).toHaveProperty('value', 'read-only');
  });

  it('keeps a chosen mode in the pane content, so it is restored with the window', () => {
    const { actions } = renderPane();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'edit' } });
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'chat',
      agent: null,
      directory: '/work/demo',
      mode: 'edit',
    });
  });

  it('keeps the mode when the agent changes', () => {
    const { actions } = renderPane({
      content: { type: 'chat', agent: 'claude', directory: '/work/v', mode: 'edit' },
    });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'chat',
      agent: 'codex',
      directory: '/work/v',
      mode: 'edit',
    });
  });

  it('offers only the two safe modes', () => {
    renderPane();
    const options = Array.from(screen.getByLabelText('Mode').querySelectorAll('option'));
    expect(options.map((option) => option.textContent)).toEqual([
      'Read only',
      'Edit files and graph',
    ]);
    expect(screen.getByLabelText('Mode')).toHaveProperty('value', 'read-only');
  });

  it('stops a run with agent_cancel and marks the message as stopped', () => {
    renderPane();
    sendMessage('hi');
    const run = lastRun();
    feed(run, delta('Half an ans'));

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(commandCalls('agent_cancel')).toEqual([{ id: run.id }]);
    expect(texts('.chat-stopped')).toEqual(['Stopped']);
    expect(screen.queryByRole('alert')).toBeNull();

    // What the stopped process still says is dropped.
    feed(run, delta('wer'));
    exit(run, null, 'killed');
    expect(texts('.chat-assistant')).toEqual(['Half an ansStopped']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows why the agent could not start', async () => {
    tauri.invoke.mockRejectedValue('claude was not found. Is it installed?');
    renderPane();
    sendMessage('hi');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('claude was not found. Is it installed?');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows the end of stderr when the agent exits with an error', () => {
    renderPane();
    sendMessage('hi');
    exit(lastRun(), 1, 'warming up\nError: not logged in\n');

    expect(screen.getByRole('alert').textContent).toBe(
      'The agent exited with code 1\nwarming up\nError: not logged in',
    );
  });

  it('does not send while a run is active', () => {
    renderPane();
    sendMessage('one');
    type('two');
    fireEvent.keyDown(composer(), { key: 'Enter' });

    expect(runs()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(composer()).toHaveProperty('value', 'two');
  });

  it('sends on Enter and not on Shift+Enter', () => {
    renderPane();
    type('hello');
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(runs()).toHaveLength(0);

    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(runs()).toHaveLength(1);
    expect(lastRun().prompt).toBe('hello');
  });

  it('does not send an empty message', () => {
    renderPane();
    type('   ');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(runs()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
  });

  it('starts a new chat when the agent changes, and records the choice', () => {
    const { actions, rerender } = renderPane();
    sendMessage('first');
    const first = lastRun();
    feed(first, { type: 'system', subtype: 'init', session_id: 's-1' }, delta('Hello'));
    exit(first);

    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });

    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'chat',
      agent: 'codex',
      directory: '/work/demo',
    });
    expect(texts('.chat-user')).toEqual([]);
    expect(texts('.chat-assistant')).toEqual([]);

    sendMessage('to codex');
    const second = lastRun();
    expect(second.agent).toBe('codex');
    expect(second.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/work/demo',
      '-s',
      'read-only',
      '-',
    ]);

    // The workspace echoes the change back. The chat in progress survives it.
    rerender({ content: { type: 'chat', agent: 'codex', directory: '/work/demo' } });
    expect(texts('.chat-user')).toEqual(['to codex']);
    expect(commandCalls('agent_cancel')).toEqual([]);
    expect(savedContents(actions).filter((saved) => saved.history === undefined)).toHaveLength(1);
  });

  it('reads Codex lines and resumes the thread on a follow-up', () => {
    renderPane({ content: { type: 'chat', agent: 'codex', directory: '/work/demo' } });
    sendMessage('first');
    const first = lastRun();
    expect(first.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/work/demo',
      '-s',
      'read-only',
      '-',
    ]);
    feed(
      first,
      { type: 'thread.started', thread_id: 'th-9' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bash -lc ls',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bash -lc ls',
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Two files.' } },
      { type: 'turn.completed', usage: {} },
    );
    exit(first);
    expect(texts('.chat-tool')).toEqual(['Run bash -lc ls']);
    expect(texts('.chat-assistant')).toEqual(['Two files.']);

    sendMessage('second');
    expect(lastRun().args).toEqual([
      'exec',
      'resume',
      'th-9',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '-',
    ]);
    expect(lastRun().cwd).toBe('/work/demo');
  });

  it('starts a new chat when the agent is changed from outside', () => {
    const { rerender } = renderPane();
    sendMessage('first');
    const first = lastRun();
    feed(first, delta('Hello'));

    rerender({ content: { type: 'chat', agent: 'codex', directory: '/work/demo' } });

    expect(commandCalls('agent_cancel')).toEqual([{ id: first.id }]);
    expect(texts('.chat-user')).toEqual([]);
    expect(screen.getByLabelText('Agent')).toHaveProperty('value', 'codex');
  });

  it('clears the transcript and the session with New chat', () => {
    renderPane();
    sendMessage('first');
    const first = lastRun();
    feed(first, { type: 'system', subtype: 'init', session_id: 's-1' }, delta('Hello'));
    exit(first);

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(texts('.chat-user')).toEqual([]);

    sendMessage('fresh');
    expect(lastRun().args).toEqual(CLAUDE_FIRST_ARGS);
  });

  it('falls back to Claude Code for an agent it does not know', () => {
    renderPane({ content: { type: 'chat', agent: 'sh', directory: null } });
    expect(screen.getByLabelText('Agent')).toHaveProperty('value', 'claude');
    expect(screen.getByTitle('Working directory').textContent).toBe('~');
    sendMessage('hi');
    expect(lastRun().agent).toBe('claude');
    expect(lastRun().cwd).toBeNull();
  });

  it('opens web links in a pane and never navigates the window', () => {
    const { actions } = renderPane();
    sendMessage('hi');
    feed(lastRun(), {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '[docs](https://example.com/docs) and [local](./readme.md)' },
        ],
      },
    });

    const web = screen.getByRole('link', { name: 'docs' });
    const webClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      web.dispatchEvent(webClick);
    });
    expect(webClick.defaultPrevented).toBe(true);
    expect(actions.openPane).toHaveBeenCalledWith({ type: 'web', url: 'https://example.com/docs' });

    const local = screen.getByRole('link', { name: 'local' });
    const localClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      local.dispatchEvent(localClick);
    });
    expect(localClick.defaultPrevented).toBe(true);
    expect(actions.openPane).toHaveBeenCalledTimes(1);
  });

  it('badges a run that finishes in the background and clears it on focus', () => {
    const { actions, rerender } = renderPane({ active: false });
    sendMessage('hi');
    exit(lastRun());
    expect(actions.setBadge).toHaveBeenCalledWith({ text: 'done', color: null });
    expect(actions.setBadge).not.toHaveBeenCalledWith(null);

    rerender({ active: true });
    expect(actions.setBadge).toHaveBeenLastCalledWith(null);
  });

  it('badges a background run that exits with an error as failed, not done', () => {
    const { actions } = renderPane({ active: false });
    sendMessage('hi');
    exit(lastRun(), 1, 'Error: not logged in\n');
    expect(actions.setBadge).toHaveBeenCalledWith({ text: 'failed', color: '#ff7b72' });
    expect(actions.setBadge).not.toHaveBeenCalledWith({ text: 'done', color: null });
  });

  it('badges a background run that a signal ended as failed', () => {
    const { actions } = renderPane({ active: false });
    sendMessage('hi');
    exit(lastRun(), null);
    expect(actions.setBadge).toHaveBeenCalledWith({ text: 'failed', color: '#ff7b72' });
    expect(actions.setBadge).not.toHaveBeenCalledWith({ text: 'done', color: null });
  });

  it('badges a background run that reports an error and exits with code 0 as failed', () => {
    const { actions } = renderPane({ active: false });
    sendMessage('hi');
    const run = lastRun();
    feed(run, { type: 'result', subtype: 'error_during_execution', is_error: true });
    exit(run);
    expect(actions.setBadge).toHaveBeenCalledWith({ text: 'failed', color: '#ff7b72' });
    expect(actions.setBadge).not.toHaveBeenCalledWith({ text: 'done', color: null });
  });

  it('badges a background run that could not start as failed', async () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === 'agent_run'
        ? Promise.reject(new Error('claude is not installed'))
        : Promise.resolve(),
    );
    const { actions } = renderPane({ active: false });
    sendMessage('hi');
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.setBadge).toHaveBeenCalledWith({ text: 'failed', color: '#ff7b72' });
  });

  it('does not badge a run that finishes while the pane is active', () => {
    const { actions } = renderPane({ active: true });
    sendMessage('hi');
    exit(lastRun());
    expect(actions.setBadge).not.toHaveBeenCalledWith({ text: 'done', color: null });
  });

  it('focuses the composer when the pane becomes active', () => {
    const { rerender } = renderPane({ active: false });
    expect(document.activeElement).not.toBe(composer());
    rerender({ active: true });
    expect(document.activeElement).toBe(composer());
  });

  it('stops the run when the pane goes away', () => {
    renderPane();
    sendMessage('hi');
    const run = lastRun();
    cleanup();
    expect(commandCalls('agent_cancel')).toEqual([{ id: run.id }]);
  });

  it('writes a debug snapshot of the transcript', () => {
    vi.useFakeTimers();
    renderPane({ debug: true });
    sendMessage('hi');
    const run = lastRun();
    feed(
      run,
      { type: 'system', subtype: 'init', session_id: 's-1' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      },
      delta('Hello'),
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(commandCalls('debug_snapshot').at(-1)).toEqual({
      id: 'chat-1',
      text: 'agent=claude mode=read-only status=running session=s-1\nyou: hi\ntool: Read a.ts\nagent: Hello',
    });
  });

  it('shows an image in a reply as a link, and never loads it', () => {
    renderPane();
    sendMessage('hi');
    feed(lastRun(), delta('Look: ![chart](https://example.com/pixel.png?k=secret) done'));

    expect(document.querySelector('.chat-assistant img')).toBeNull();
    expect(screen.getByText('image: chart')).toBeTruthy();
  });
});

describe('ChatPane run cost', () => {
  it('shows what a Claude Code run reported it cost', () => {
    renderPane();
    sendMessage('hi');
    const run = lastRun();
    feed(run, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hi',
      session_id: 's-1',
      total_cost_usd: 0.0421,
    });
    expect(texts('.chat-cost')).toEqual([]);
    exit(run);
    expect(texts('.chat-cost')).toEqual(['Cost: $0.0421']);
  });

  it('shows the cost as unknown for Codex, which reports none', () => {
    renderPane({ content: { type: 'chat', agent: 'codex', directory: '/work/demo' } });
    sendMessage('hi');
    const run = lastRun();
    feed(
      run,
      { type: 'thread.started', thread_id: 'th-9' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    );
    exit(run);
    expect(texts('.chat-cost')).toEqual(['Cost: unknown']);
  });

  it('shows the cost as unknown for a run that failed before reporting one', () => {
    renderPane();
    sendMessage('hi');
    exit(lastRun(), 1, 'Error: not logged in\n');
    expect(texts('.chat-cost')).toEqual(['Cost: unknown']);
  });

  it("keeps each run's cost through a quit and a reopen", () => {
    const { actions } = renderPane();
    sendMessage('one');
    const first = lastRun();
    feed(first, { type: 'result', subtype: 'success', session_id: 's-1', total_cost_usd: 0.01 });
    exit(first);
    sendMessage('two');
    const second = lastRun();
    feed(second, { type: 'result', subtype: 'success', session_id: 's-1' });
    exit(second);
    const saved = lastSaved(actions);

    cleanup();
    renderPane({ content: afterReopen(saved) });
    expect(texts('.chat-cost')).toEqual(['Cost: $0.0100', 'Cost: unknown']);
  });
});

describe('ChatPane saved chat', () => {
  it('restores the transcript and the session after a quit and a reopen', () => {
    const { actions } = renderPane();
    sendMessage('hi');
    const first = lastRun();
    feed(
      first,
      { type: 'system', subtype: 'init', session_id: 's-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    );
    exit(first);
    const saved = lastSaved(actions);
    expect(saved.history).toMatchObject({ sessionId: 's-1', running: false, truncated: false });

    cleanup();
    tauri.invoke.mockClear();
    renderPane({ content: afterReopen(saved) });

    expect(texts('.chat-user')).toEqual(['hi']);
    expect(texts('.chat-assistant')).toEqual(['Hello']);
    expect(document.querySelector('.chat-interrupted')).toBeNull();
    expect(runs()).toEqual([]);

    sendMessage('again');
    expect(lastRun().args.slice(-2)).toEqual(['--resume', 's-1']);
  });

  it('saves the start of a run at once, so a quit just after it is remembered', () => {
    const { actions } = renderPane();
    sendMessage('hi');
    expect(lastSaved(actions).history).toMatchObject({
      running: true,
      items: [{ kind: 'user', text: 'hi' }],
    });
  });

  it('shows a run that was in progress at quit as interrupted, and never restarts it', () => {
    vi.useFakeTimers();
    const first = renderPane();
    sendMessage('hi');
    feed(lastRun(), { type: 'system', subtype: 'init', session_id: 's-1' }, delta('Hel'));
    const midRun = { ...lastSaved(first.actions) };
    first.rerender({ content: midRun });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const saved = lastSaved(first.actions);
    expect(saved.history).toMatchObject({ running: true, sessionId: 's-1' });
    expect(saved.history?.items).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'Hel', stopped: false },
    ]);

    cleanup();
    tauri.invoke.mockClear();
    const { actions } = renderPane({ content: afterReopen(saved) });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(texts('.chat-interrupted')).toEqual([
      'Interrupted. This run did not finish and was not restarted.',
    ]);
    expect(texts('.chat-assistant')).toEqual(['Hel']);
    expect(texts('.chat-cost')).toEqual(['Cost: unknown']);
    expect(runs()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByText('Working…')).toBeNull();
    // The mark is saved, so it is still there after the next quit.
    expect(lastSaved(actions).history).toMatchObject({ running: false });
    expect(lastSaved(actions).history?.items).toContainEqual({ kind: 'interrupted' });

    sendMessage('carry on');
    expect(runs()).toHaveLength(1);
    expect(lastRun().args.slice(-2)).toEqual(['--resume', 's-1']);
  });

  it('forgets the saved chat on New chat', () => {
    const { actions } = renderPane();
    sendMessage('hi');
    exit(lastRun());
    expect(lastSaved(actions).history).toBeDefined();

    // The workspace hands the saved content back to the pane.
    cleanup();
    const reopened = renderPane({ content: lastSaved(actions) });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(lastSaved(reopened.actions).history).toBeUndefined();
  });

  it('says when a restored chat came back without its oldest messages', () => {
    renderPane({
      content: {
        type: 'chat',
        agent: null,
        directory: '/work/demo',
        history: {
          sessionId: null,
          running: false,
          truncated: true,
          items: [{ kind: 'user', text: 'hi' }],
        },
      },
    });
    expect(screen.getByText(/Earlier messages were not kept/)).toBeTruthy();
  });

  it('does not pass on a saved session id that could be read as an option', () => {
    renderPane({
      content: {
        type: 'chat',
        agent: null,
        directory: '/work/demo',
        history: {
          sessionId: '--dangerously-skip-permissions',
          running: false,
          truncated: false,
          items: [{ kind: 'user', text: 'hi' }],
        },
      },
    });
    sendMessage('again');
    expect(lastRun().args).toEqual(CLAUDE_FIRST_ARGS);
  });
});

describe('ChatPane folder trust', () => {
  it('asks before the first run in a folder that is not trusted, and holds the message', () => {
    renderPane({ content: UNTRUSTED });
    expect(trustQuestion()?.textContent).toContain(
      'Trust this folder? Its own agent settings, skills and hooks will apply.',
    );

    type('hello');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(runs()).toHaveLength(0);
    expect(composer()).toHaveProperty('value', 'hello');
  });

  it('shows the composer as waiting on the trust answer, with Trust as the main button', () => {
    renderPane({ content: UNTRUSTED });
    const question = trustQuestion();
    expect(question).not.toBeNull();
    // Trust is the one button marked as the main answer.
    expect(screen.getByRole('button', { name: 'Trust' }).getAttribute('data-primary')).toBe('true');
    expect(screen.getByRole('button', { name: 'Not now' }).getAttribute('data-primary')).toBeNull();

    // The composer says what it is waiting for, and points at the question.
    expect(composer().getAttribute('placeholder')).toBe('Answer the trust question above to send');
    expect(composer().closest('.chat-composer')?.getAttribute('data-waiting')).toBe('trust');
    const describedBy = composer().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain('Trust this folder?');
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('title')).toBe(
      'Answer the question above first',
    );

    // Once answered, the composer is an ordinary composer again.
    fireEvent.click(screen.getByRole('button', { name: 'Trust' }));
    expect(composer().getAttribute('placeholder')).toBe('Message Claude Code');
    expect(composer().closest('.chat-composer')?.getAttribute('data-waiting')).toBeNull();
    expect(composer().getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the folder settings out after "Not now", says what is off, and asks once', () => {
    renderPane({ content: UNTRUSTED });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(trustQuestion()).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Its own agent settings, hooks, skills, instructions file (CLAUDE.md) and tool servers are off',
    );

    sendMessage('first');
    const first = lastRun();
    expect(first.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'plan',
      '--setting-sources',
      'user',
      '--disallowedTools',
      'Read(.obsidian/**)',
      'Read(**/.obsidian/**)',
    ]);
    feed(first, { type: 'system', subtype: 'init', session_id: 's-1' });
    exit(first);

    sendMessage('second');
    expect(trustQuestion()).toBeNull();
    expect(lastRun().args.slice(7, 9)).toEqual(['--setting-sources', 'user']);
    expect(window.localStorage.getItem(TRUST_KEY)).not.toContain('/work/download');
  });

  it('loads the folder settings after "Trust", and remembers the folder', () => {
    renderPane({ content: UNTRUSTED });
    fireEvent.click(screen.getByRole('button', { name: 'Trust' }));
    expect(trustQuestion()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    sendMessage('hello');
    expect(lastRun().args).toEqual(CLAUDE_FIRST_ARGS);
    expect(window.localStorage.getItem(TRUST_KEY)).toContain('/work/download');

    // A new pane on the same folder, as after a restart, does not ask again.
    cleanup();
    renderPane({ content: UNTRUSTED });
    expect(trustQuestion()).toBeNull();
    sendMessage('again');
    expect(lastRun().args).not.toContain('--setting-sources');
  });

  it('can be trusted later from the notice', () => {
    renderPane({ content: UNTRUSTED });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Trust folder' }));
    expect(screen.queryByRole('status')).toBeNull();
    sendMessage('hello');
    expect(lastRun().args).not.toContain('--setting-sources');
  });

  it('trusts one folder at a time: a folder below or beside it still asks', () => {
    renderPane({ content: { type: 'chat', agent: null, directory: '/work/demo/inner' } });
    expect(trustQuestion()).not.toBeNull();
    cleanup();
    renderPane({ content: { type: 'chat', agent: null, directory: '/work/demo/../download' } });
    expect(trustQuestion()).not.toBeNull();
  });

  it('gives a layout file no way to mark a folder trusted', () => {
    const tab = parseLayout(`
name = "t"

[[panes]]
id = "c"
type = "chat"
directory = "/work/download"
mode = "edit"
trusted = true
trust = "yes"
`);
    const content = leavesOf(tab.root)[0]?.content;
    if (content?.type !== 'chat') {
      throw new Error('the layout did not give a chat pane');
    }
    expect(Object.keys(content).sort()).toEqual(['agent', 'directory', 'mode', 'type']);

    renderPane({ content });
    expect(trustQuestion()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    sendMessage('hello');
    expect(lastRun().args).toContain('--setting-sources');
    expect(window.localStorage.getItem(TRUST_KEY)).not.toContain('/work/download');
  });

  it('ignores a trust field smuggled into the pane content', () => {
    const smuggled = { ...UNTRUSTED, trusted: true, trust: 'trusted' };
    renderPane({ content: smuggled });
    expect(trustQuestion()).not.toBeNull();
  });

  it("does not ask for the home directory, whose settings are the person's own", () => {
    renderPane({ content: { type: 'chat', agent: null, directory: null } });
    expect(trustQuestion()).toBeNull();
    sendMessage('hello');
    expect(lastRun().args).toEqual(CLAUDE_FIRST_ARGS);
  });

  it('remembers a folder under home by its absolute path', async () => {
    tauri.invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'fs_home' ? '/Users/tester' : undefined),
    );
    renderPane({ content: { type: 'chat', agent: null, directory: '~/vault' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Trust' }));
    expect(window.localStorage.getItem(TRUST_KEY)).toContain('/Users/tester/vault');
    sendMessage('hello');
    expect(lastRun().args).not.toContain('--setting-sources');
  });

  it('runs untrusted, with no way to trust, when the folder cannot be made absolute', async () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === 'fs_home' ? Promise.reject(new Error('no home')) : Promise.resolve(undefined),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPane({ content: { type: 'chat', agent: null, directory: '~/vault' } });
    await screen.findByRole('status');
    expect(trustQuestion()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trust folder' })).toBeNull();
    sendMessage('hello');
    expect(lastRun().args).toContain('--setting-sources');
    logged.mockRestore();
  });

  it('does not ask for Codex, which keeps its own record of trusted projects', () => {
    renderPane({ content: { ...UNTRUSTED, agent: 'codex' } });
    expect(trustQuestion()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    sendMessage('hello');
    expect(lastRun().args.some((arg) => arg.includes('bypass'))).toBe(false);
  });
});
