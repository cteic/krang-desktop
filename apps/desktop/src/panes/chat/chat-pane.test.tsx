// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatContent } from '../../workspace/model';
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
];

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
  content = { type: 'chat', agent: null, directory: '~/src/demo' },
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

function texts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map((node) => node.textContent);
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockResolvedValue(undefined);
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
    expect(run.cwd).toBe('~/src/demo');
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

  it('offers only the two safe modes', () => {
    renderPane();
    const options = Array.from(screen.getByLabelText('Mode').querySelectorAll('option'));
    expect(options.map((option) => option.textContent)).toEqual(['Read only', 'Can edit files']);
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
      directory: '~/src/demo',
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
      '-s',
      'read-only',
      '-',
    ]);

    // The workspace echoes the change back. The chat in progress survives it.
    rerender({ content: { type: 'chat', agent: 'codex', directory: '~/src/demo' } });
    expect(texts('.chat-user')).toEqual(['to codex']);
    expect(commandCalls('agent_cancel')).toEqual([]);
    expect(actions.replaceContent).toHaveBeenCalledTimes(1);
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

    rerender({ content: { type: 'chat', agent: 'codex', directory: '~/src/demo' } });

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
});
