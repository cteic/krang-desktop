import type { FilesContent } from '../../workspace/model';
import type { PaneProps } from '../pane-props';

export function FilesPane({ content }: PaneProps<FilesContent>) {
  return (
    <div className="pane-placeholder">
      <p>The files pane is not built yet.</p>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </div>
  );
}
