// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AddPaneChoice, AddPaneMenu } from './add-pane-menu';

const CHOICES: AddPaneChoice[] = [
  { label: 'Terminal', content: { type: 'terminal', directory: null, commands: [] } },
  { label: 'Files', content: { type: 'files', directory: null } },
  { label: 'Chat', content: { type: 'chat', agent: null, directory: null } },
];

function renderMenu(disabled = false) {
  const onAdd = vi.fn();
  render(<AddPaneMenu choices={CHOICES} disabled={disabled} onAdd={onAdd} />);
  return onAdd;
}

function opener(): HTMLElement {
  return screen.getByRole('button', { name: 'Add pane' });
}

function open() {
  fireEvent.click(opener());
}

function itemNames(): string[] {
  return screen.queryAllByRole('menuitem').map((item) => item.textContent);
}

afterEach(cleanup);

describe('AddPaneMenu', () => {
  it('starts closed, with one button', () => {
    renderMenu();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opener().getAttribute('aria-expanded')).toBe('false');
  });

  it('lists every pane type when opened, and puts focus on the first', () => {
    renderMenu();
    open();
    expect(itemNames()).toEqual(['Terminal', 'Files', 'Chat']);
    expect(opener().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Terminal' }));
  });

  it('adds the chosen pane and closes', () => {
    const onAdd = renderMenu();
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({ type: 'chat', agent: null, directory: null });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves through the items with the arrow keys, Home and End', () => {
    renderMenu();
    open();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Files');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Chat');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Terminal');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Chat');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('Terminal');
  });

  it('closes on Escape and gives focus back to the button, adding nothing', () => {
    const onAdd = renderMenu();
    open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('closes on a press outside it, and when the window loses focus', () => {
    renderMenu();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.blur(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when its button is pressed again', () => {
    renderMenu();
    open();
    open();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not open when there is no pane to add beside', () => {
    renderMenu(true);
    open();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
