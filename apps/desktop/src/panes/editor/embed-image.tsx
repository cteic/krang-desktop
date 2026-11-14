import { useEffect, useState } from 'react';

import type { EmbedResolver } from './embeds';

export interface EmbedImageProps {
  /** The file name written in the embed. */
  name: string;
  width?: number | undefined;
  height?: number | undefined;
  /** Null when there is nowhere to look, as in a buffer with no file. */
  resolve: EmbedResolver | null;
}

/**
 * An `![[image.png]]` embed. It shows the image once the file is found, and
 * until then, or when there is no such image, the name as a muted chip.
 */
export function EmbedImage({ name, width, height, resolve }: EmbedImageProps) {
  const [found, setFound] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFound(null);
    if (resolve === null) {
      return;
    }
    resolve(name)
      .then((url) => {
        if (!cancelled) {
          setFound(url);
        }
      })
      .catch(() => {
        // A search that fails leaves the chip in place.
      });
    return () => {
      cancelled = true;
    };
  }, [name, resolve]);

  if (found === null) {
    return (
      <span className="editor-chip editor-embed-missing" title={`Embedded file: ${name}`}>
        {name}
      </span>
    );
  }
  return <img src={found} alt={name} width={width} height={height} />;
}
