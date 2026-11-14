import { dbPlaceholder } from '@trath/db/placeholder';

export function cliPlaceholder(): string {
  return `cli on ${dbPlaceholder()}`;
}
