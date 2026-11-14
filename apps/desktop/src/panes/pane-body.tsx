import type { PaneContent } from '../workspace/model';

import { ChatPane } from './chat/chat-pane';
import { EditorPane } from './editor/editor-pane';
import { FilesPane } from './files/files-pane';
import { GraphPane } from './graph/graph-pane';
import type { PaneProps } from './pane-props';
import { TerminalPane } from './terminal/terminal-pane';
import { WebPane } from './web/web-pane';

/** Picks the component for a pane's content type. The one place types meet. */
export function PaneBody({ content, ...rest }: PaneProps<PaneContent>) {
  switch (content.type) {
    case 'terminal':
      return <TerminalPane content={content} {...rest} />;
    case 'files':
      return <FilesPane content={content} {...rest} />;
    case 'editor':
      return <EditorPane content={content} {...rest} />;
    case 'web':
      return <WebPane content={content} {...rest} />;
    case 'chat':
      return <ChatPane content={content} {...rest} />;
    case 'graph':
      return <GraphPane content={content} {...rest} />;
  }
}
