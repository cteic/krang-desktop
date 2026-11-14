import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

import { basename } from './paths';

/**
 * The language for a file, chosen by its name. The description is small; the
 * grammar itself only downloads when `load()` is called on it.
 */
export function findLanguage(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, basename(path));
}
