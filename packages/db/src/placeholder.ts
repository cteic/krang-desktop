import { corePlaceholder } from '@trath/core/placeholder';

export function dbPlaceholder(): string {
  return `db on ${corePlaceholder()}`;
}
