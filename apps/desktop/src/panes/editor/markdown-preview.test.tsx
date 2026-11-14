// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownPreview } from './markdown-preview';

afterEach(cleanup);

function show(text: string, baseDir: string | null = '/notes') {
  const onOpen = vi.fn();
  render(<MarkdownPreview text={text} baseDir={baseDir} onOpen={onOpen} />);
  return onOpen;
}

describe('MarkdownPreview', () => {
  it('renders a GFM table, task list and strikethrough', () => {
    show(
      [
        '| Name | Qty |',
        '| --- | --- |',
        '| Tea | 2 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~old~~',
      ].join('\n'),
    );

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Qty' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: 'Tea' })).toBeTruthy();

    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(screen.getByText('old').tagName).toBe('DEL');
  });

  it('renders wikilinks as links, with and without a label', () => {
    show('See [[Note name]] and [[Other|that one]].');

    expect(screen.getByRole('link', { name: 'Note name' }).className).toBe('editor-wikilink');
    expect(screen.getByRole('link', { name: 'that one' })).toBeTruthy();
  });

  it('keeps wikilinks out of fenced code and inline code', () => {
    show(['Inline `[[A]]` here.', '', '```', '[[B]]', '```', '', 'Real [[C]].'].join('\n'));

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'C' })).toBeTruthy();
    expect(screen.getByText('[[A]]').tagName).toBe('CODE');
    expect(screen.getByText('[[B]]').tagName).toBe('CODE');
  });

  it('opens a wikilink as a Markdown file in the same directory', () => {
    const onOpen = show('[[Note name]]');

    fireEvent.click(screen.getByRole('link', { name: 'Note name' }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith({ type: 'editor', path: '/notes/Note name.md' });
  });

  it('opens an http link in a web pane and does not navigate', () => {
    const onOpen = show('[site](https://example.com/page)');

    const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'site' }));

    expect(notPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith({
      type: 'web',
      url: 'https://example.com/page',
    });
  });

  it('opens a relative link to a text file in an editor pane', () => {
    const onOpen = show('[plan](../plans/q1.md#goals)', '/notes/work');

    fireEvent.click(screen.getByRole('link', { name: 'plan' }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith({ type: 'editor', path: '/notes/plans/q1.md' });
  });

  it('prevents navigation even for links it does not follow', () => {
    const onOpen = show('[top](#top) and [mail](mailto:sam@example.com)');

    expect(fireEvent.click(screen.getByRole('link', { name: 'top' }))).toBe(false);
    expect(fireEvent.click(screen.getByRole('link', { name: 'mail' }))).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('prevents a middle click from opening a window', () => {
    show('[site](https://example.com)');

    const link = screen.getByRole('link', { name: 'site' });
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true }))).toBe(
      false,
    );
  });

  it('loads relative images through the local-file scheme', () => {
    show('![diagram](img/flow%20chart.png) ![remote](https://example.com/a.png)', '/notes/work');

    expect(screen.getByRole('img', { name: 'diagram' }).getAttribute('src')).toBe(
      'localfile://localhost/notes/work/img/flow%20chart.png',
    );
    expect(screen.getByRole('img', { name: 'remote' }).getAttribute('src')).toBe(
      'https://example.com/a.png',
    );
  });

  it('drops an unsafe link address', () => {
    show('[bad](javascript:alert(1))');

    expect(screen.getByText('bad').getAttribute('href')).toBe('');
  });
});
