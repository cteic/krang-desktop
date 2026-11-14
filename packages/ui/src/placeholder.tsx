import { corePlaceholder } from '@trath/core/placeholder';

export interface PlaceholderProps {
  label: string;
}

export function Placeholder({ label }: PlaceholderProps) {
  return (
    <p>
      {label} on {corePlaceholder()}
    </p>
  );
}
