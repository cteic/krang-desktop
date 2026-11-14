import type { ChatContent } from '../../workspace/model';
import type { PaneProps } from '../pane-props';

export function ChatPane({ content }: PaneProps<ChatContent>) {
  return (
    <div className="pane-placeholder">
      <p>The chat pane is not built yet.</p>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </div>
  );
}
