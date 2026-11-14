import { dbPlaceholder } from '@krang-desktop/db/placeholder';

export function cliPlaceholder(): string {
  return `cli on ${dbPlaceholder()}`;
}
