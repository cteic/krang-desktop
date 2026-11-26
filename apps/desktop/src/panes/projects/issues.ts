import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

/**
 * The fields of a krang work-store issue that the projects pane shows. The
 * Rust side hands over the text `krang issue ls --json` prints, and it is
 * checked here before any of it is drawn. Status and priority stay strings,
 * so a value krang adds later shows up instead of failing the whole read.
 */
const issueSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  project: z.string().nullable(),
  priority: z.string(),
  blocked_by: z.array(z.string()),
  claimed_by: z.string().nullable(),
  updated: z.string(),
});

export type Issue = z.infer<typeof issueSchema>;

const issuesSchema = z.array(issueSchema);

/** Parses what `krang issue ls --json` printed. Throws on any other shape. */
export function parseIssues(text: string): Issue[] {
  const parsed: unknown = JSON.parse(text);
  return issuesSchema.parse(parsed);
}

export async function fetchIssues(): Promise<Issue[]> {
  const text = await invoke<string>('projects_read');
  return parseIssues(text);
}

/** A message fit for the pane, from whatever a failed read threw. */
export function errorText(error: unknown): string {
  if (error instanceof z.ZodError) {
    return 'krang printed issues in a shape this pane does not know';
  }
  if (error instanceof SyntaxError) {
    return 'krang printed something that is not JSON';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
