// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaneActions } from '../pane-props';

import { WebPane } from './web-pane';

const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const replaceContent = vi.fn<PaneActions['replaceContent']>();
const actions: PaneActions = {
  openPane: vi.fn<PaneActions['openPane']>(),
  replaceContent,
  setTitle: vi.fn<PaneActions['setTitle']>(),
  setBadge: vi.fn<PaneActions['setBadge']>(),
  close: vi.fn<PaneActions['close']>(),
};

interface PaneOptions {
  active?: boolean;
  debug?: boolean;
}

function pane(url: string, { active = true, debug = false }: PaneOptions = {}) {
  return (
    <WebPane
      paneId="pane-1"
      name="web"
      content={{ type: 'web', url }}
      active={active}
      debug={debug}
      actions={actions}
    />
  );
}

function addressField(): HTMLInputElement {
  const field = screen.getByLabelText('Address');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('the address field is not an input');
  }
  return field;
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe');
}

function frameSrc(): string | null {
  return frame()?.getAttribute('src') ?? null;
}

function existingFrame(): HTMLIFrameElement {
  const element = frame();
  if (element === null) {
    throw new Error('there is no frame');
  }
  return element;
}

function type(text: string) {
  fireEvent.change(addressField(), { target: { value: text } });
}

function pressEnter() {
  const form = addressField().closest('form');
  if (form === null) {
    throw new Error('the address field is not in a form');
  }
  fireEvent.submit(form);
}

function go(text: string) {
  type(text);
  pressEnter();
}

function isLoading(): boolean {
  return document.querySelector('.web-loading[data-loading="true"]') !== null;
}

beforeEach(() => {
  invokeMock.mockImplementation((command) =>
    Promise.resolve(command === 'fs_home' ? '/Users/tester' : null),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('WebPane', () => {
  it('loads a typed local host over http and records the address', () => {
    render(pane(''));
    expect(frame()).toBeNull();

    go('localhost:3000');

    expect(frameSrc()).toBe('http://localhost:3000/');
    expect(addressField().value).toBe('http://localhost:3000/');
    expect(replaceContent).toHaveBeenCalledExactlyOnceWith({
      type: 'web',
      url: 'http://localhost:3000/',
    });
  });

  it('sets the frame attributes that keep a page contained', () => {
    render(pane('http://localhost:3000'));
    const element = existingFrame();
    expect(element.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
    );
    expect(element.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(element.getAttribute('title')).toBe('Web page: http://localhost:3000/');
  });

  it('loads an absolute path through the localfile scheme and shows the path', () => {
    render(pane(''));
    go('/Users/x/my site/index.html');

    expect(frameSrc()).toBe('localfile://localhost/Users/x/my%20site/index.html');
    expect(addressField().value).toBe('/Users/x/my site/index.html');
  });

  it('expands a home path with the home folder from the shell', async () => {
    render(pane(''));
    go('~/site/index.html');

    await waitFor(() => {
      expect(frameSrc()).toBe('localfile://localhost/Users/tester/site/index.html');
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_home');
    expect(replaceContent).toHaveBeenCalledExactlyOnceWith({
      type: 'web',
      url: 'localfile://localhost/Users/tester/site/index.html',
    });
  });

  it('refuses a javascript address and leaves the frame alone', () => {
    render(pane('http://localhost:3000'));
    const before = existingFrame();

    go('javascript:alert(1)');

    expect(screen.getByRole('alert').textContent).toContain('Cannot open "javascript:" addresses');
    expect(frame()).toBe(before);
    expect(frameSrc()).toBe('http://localhost:3000/');
    expect(replaceContent).not.toHaveBeenCalled();
  });

  it('says so when the text is not an address, without searching for it', () => {
    render(pane(''));
    go('how do I centre a div');

    expect(screen.getByRole('alert').textContent).toContain('not an address');
    expect(frame()).toBeNull();

    type('localhost');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('goes back and forward through its own history', () => {
    render(pane(''));
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect(back).toHaveProperty('disabled', true);
    expect(forward).toHaveProperty('disabled', true);

    go('localhost:3000');
    go('localhost:5173');
    expect(frameSrc()).toBe('http://localhost:5173/');
    expect(forward).toHaveProperty('disabled', true);

    fireEvent.click(back);
    expect(frameSrc()).toBe('http://localhost:3000/');
    expect(addressField().value).toBe('http://localhost:3000/');
    expect(back).toHaveProperty('disabled', true);
    expect(replaceContent).toHaveBeenLastCalledWith({ type: 'web', url: 'http://localhost:3000/' });

    fireEvent.click(forward);
    expect(frameSrc()).toBe('http://localhost:5173/');
    expect(replaceContent).toHaveBeenLastCalledWith({ type: 'web', url: 'http://localhost:5173/' });
  });

  it('reloads by replacing the frame', () => {
    render(pane('http://localhost:3000'));
    const before = existingFrame();
    fireEvent.load(before);
    expect(isLoading()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(frame()).not.toBe(before);
    expect(frameSrc()).toBe('http://localhost:3000/');
    expect(isLoading()).toBe(true);
  });

  it('shows the loading bar from navigation until the frame loads', () => {
    render(pane(''));
    expect(isLoading()).toBe(false);

    go('localhost:3000');
    expect(isLoading()).toBe(true);

    fireEvent.load(existingFrame());
    expect(isLoading()).toBe(false);
  });

  it('starts with the address field focused and three shortcuts', () => {
    render(pane(''));
    expect(document.activeElement).toBe(addressField());

    const shortcuts = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:4747'];
    for (const shortcut of shortcuts) {
      expect(screen.getByRole('button', { name: shortcut })).not.toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: 'http://127.0.0.1:4747' }));
    expect(frameSrc()).toBe('http://127.0.0.1:4747/');
    expect(replaceContent).toHaveBeenCalledExactlyOnceWith({
      type: 'web',
      url: 'http://127.0.0.1:4747/',
    });
    expect(screen.queryByRole('button', { name: 'http://localhost:3000' })).toBeNull();
  });

  it('focuses the empty address field when the pane becomes active', () => {
    const { rerender } = render(pane('', { active: false }));
    expect(document.activeElement).not.toBe(addressField());

    rerender(pane('', { active: true }));
    expect(document.activeElement).toBe(addressField());
  });

  it('does not reload when its own navigation comes back as a prop', () => {
    const { rerender } = render(pane(''));
    go('localhost:3000');
    const before = existingFrame();

    rerender(pane('http://localhost:3000/'));

    expect(frame()).toBe(before);
    expect(replaceContent).toHaveBeenCalledOnce();
  });

  it('navigates when the address changes from outside', () => {
    const { rerender } = render(pane(''));
    go('localhost:3000');
    rerender(pane('http://localhost:3000/'));

    rerender(pane('localhost:5173'));

    expect(frameSrc()).toBe('http://localhost:5173/');
    expect(addressField().value).toBe('http://localhost:5173/');
    expect(replaceContent).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(frameSrc()).toBe('http://localhost:3000/');
  });

  it('opens the address it is created with', () => {
    render(pane('/Users/x/site/'));
    expect(frameSrc()).toBe('localfile://localhost/Users/x/site/');
    expect(replaceContent).not.toHaveBeenCalled();
  });

  it('restores the current address on Escape', () => {
    render(pane('http://localhost:3000'));
    type('exam');
    expect(addressField().value).toBe('exam');

    fireEvent.keyDown(addressField(), { key: 'Escape' });
    expect(addressField().value).toBe('http://localhost:3000/');
  });

  it('focuses and selects the address on Cmd+L only while active', () => {
    const { rerender } = render(pane('http://localhost:3000', { active: false }));
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(document.activeElement).not.toBe(addressField());

    rerender(pane('http://localhost:3000', { active: true }));
    expect(document.activeElement).not.toBe(addressField());
    fireEvent.keyDown(window, { key: 'l', metaKey: true });

    const field = addressField();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it('copies the address', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(pane('/Users/x/my site/index.html'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith('/Users/x/my site/index.html');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy address' }).textContent).toBe('Copied');
    });
  });

  it('hints that a remote https page may refuse to be framed, until dismissed', () => {
    render(pane('http://localhost:3000'));
    expect(screen.queryByText(/Some sites refuse to load inside another app/)).toBeNull();

    go('example.com');
    expect(frameSrc()).toBe('https://example.com/');
    expect(screen.getByText(/Some sites refuse to load inside another app/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss hint' }));
    expect(screen.queryByText(/Some sites refuse to load inside another app/)).toBeNull();
  });

  it('offers a retry when the frame has not loaded after ten seconds', () => {
    vi.useFakeTimers();
    render(pane('http://localhost:3000'));
    const before = existingFrame();

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.queryByText('Still loading.')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Still loading.')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(frame()).not.toBe(before);
    expect(screen.queryByText('Still loading.')).toBeNull();
  });

  it('does not show the slow notice once the frame has loaded', () => {
    vi.useFakeTimers();
    render(pane('http://localhost:3000'));
    fireEvent.load(existingFrame());

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.queryByText('Still loading.')).toBeNull();
  });

  it('writes a one-line debug snapshot when debug is on', () => {
    vi.useFakeTimers();
    render(pane('http://localhost:3000', { debug: true }));
    go('localhost:5173');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.load(existingFrame());

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(invokeMock).toHaveBeenCalledWith('debug_snapshot', {
      id: 'web',
      text: 'url=http://localhost:3000/ loaded=true history=1/2',
    });
  });

  it('writes no debug snapshot when debug is off', () => {
    vi.useFakeTimers();
    render(pane('http://localhost:3000'));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
