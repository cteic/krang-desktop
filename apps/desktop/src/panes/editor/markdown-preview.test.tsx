// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EmbedResolver } from './embeds';
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

  it('shows frontmatter as a closed list of properties, not as text', () => {
    const { container } = render(
      <MarkdownPreview
        text={[
          '---',
          'kind: claim',
          'tags:',
          '  - alpha',
          '  - beta',
          '---',
          '# The title',
          '',
          'Body text.',
        ].join('\n')}
        baseDir="/notes"
        onOpen={vi.fn()}
      />,
    );

    const block = container.querySelector('details');
    expect(block).not.toBeNull();
    expect(block?.open).toBe(false);
    expect(within(screen.getByRole('group')).getByText('Properties')).toBeTruthy();
    expect(screen.getByText('kind').tagName).toBe('DT');
    expect(screen.getByText('claim').tagName).toBe('DD');
    expect(screen.getByText('alpha').className).toBe('editor-chip');
    expect(screen.getByText('beta').className).toBe('editor-chip');

    expect(screen.getByRole('heading', { level: 1, name: 'The title' })).toBeTruthy();
    expect(screen.getByText('Body text.').tagName).toBe('P');
    expect(container.textContent).not.toContain('---');
    expect(container.querySelector('hr')).toBeNull();
  });

  it('shows no properties block for a note without frontmatter', () => {
    const { container } = render(
      <MarkdownPreview text={'# Only a title'} baseDir="/notes" onOpen={vi.fn()} />,
    );
    expect(container.querySelector('details')).toBeNull();
  });

  it('draws a callout as a titled box', () => {
    const { container } = render(
      <MarkdownPreview
        text={'> [!info] Read this\n> The body of the callout.\n\n> An ordinary quote.'}
        baseDir="/notes"
        onOpen={vi.fn()}
      />,
    );

    const callout = container.querySelector('.editor-callout');
    expect(callout?.getAttribute('data-callout')).toBe('info');
    expect(callout?.querySelector('.editor-callout-title')?.textContent).toBe('Read this');
    expect(callout?.textContent).toContain('The body of the callout.');
    expect(callout?.textContent).not.toContain('[!info]');
    expect(container.querySelectorAll('blockquote')).toHaveLength(1);
  });

  it('draws a highlight, and tags as chips', () => {
    show('A ==key finding== about #matthew_effect and #clm-candidate.');

    expect(screen.getByText('key finding').tagName).toBe('MARK');
    expect(screen.getByText('#matthew_effect').className).toBe('editor-tag');
    expect(screen.getByText('#clm-candidate').className).toBe('editor-tag');
  });

  it('keeps a heading a heading, and code as code', () => {
    show(['# Heading', '', '`#not-a-tag ==no==`'].join('\n'));

    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('#not-a-tag ==no==').tagName).toBe('CODE');
  });

  it('collapses a query block to one muted line', () => {
    const { container } = render(
      <MarkdownPreview
        text={[
          '```datacorejsx',
          'return <Table rows={rows} />',
          '```',
          '',
          '```js',
          'let a;',
          '```',
        ].join('\n')}
        baseDir="/notes"
        onOpen={vi.fn()}
      />,
    );

    expect(container.querySelector('.editor-query-block')?.textContent).toBe(
      'datacorejsx query block',
    );
    expect(container.textContent).not.toContain('Table rows');
    expect(screen.getByText('let a;').tagName).toBe('CODE');
  });

  it('shows an embedded image once it is found, at the width asked for', async () => {
    const resolveEmbed: EmbedResolver = vi.fn((name: string) =>
      Promise.resolve(name === 'plot.png' ? 'localfile://localhost/vault/files/plot.png' : null),
    );
    render(
      <MarkdownPreview
        text={'![[plot.png|300]] and ![[gone.png]] and ![[Some note]]'}
        baseDir="/vault/notes"
        onOpen={vi.fn()}
        resolveEmbed={resolveEmbed}
      />,
    );

    const image = await screen.findByRole('img', { name: 'plot.png' });
    expect(image.getAttribute('src')).toBe('localfile://localhost/vault/files/plot.png');
    expect(image.getAttribute('width')).toBe('300');

    await waitFor(() => {
      expect(resolveEmbed).toHaveBeenCalledWith('gone.png');
    });
    expect(screen.getByText('gone.png').className).toContain('editor-embed-missing');
    expect(screen.getByText('Some note').className).toContain('editor-embed-missing');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('shows an embed as its name when there is nowhere to look', () => {
    show('![[plot.png]]', null);

    expect(screen.getByText('plot.png').className).toContain('editor-embed-missing');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
