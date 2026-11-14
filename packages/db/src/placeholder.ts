import { corePlaceholder } from '@krang-desktop/core/placeholder';

export function dbPlaceholder(): string {
  return `db on ${corePlaceholder()}`;
}
