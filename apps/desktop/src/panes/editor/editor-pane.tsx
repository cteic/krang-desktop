import type { EditorContent } from '../../workspace/model';
import type { PaneProps } from '../pane-props';

export function EditorPane({ content }: PaneProps<EditorContent>) {
  return (
    <div className="pane-placeholder">
      <p>The editor pane is not built yet.</p>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </div>
  );
}
