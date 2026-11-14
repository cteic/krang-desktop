import type { WebContent } from '../../workspace/model';
import type { PaneProps } from '../pane-props';

export function WebPane({ content }: PaneProps<WebContent>) {
  return (
    <div className="pane-placeholder">
      <p>The web pane is not built yet.</p>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </div>
  );
}
