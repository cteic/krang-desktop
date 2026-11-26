import { defineConfig } from '@playwright/test';

/** Not 1420: that is the port `tauri dev` uses, and it may already be running. */
const PORT = 1430;

/**
 * Browser smoke tests of the window code, with the Rust shell faked (see
 * e2e/fake-shell.ts). They prove the window starts and its panes work. They
 * do not start the real app: the Rust side has its own tests.
 */
export default defineConfig({
  testDir: './e2e',
  // Not `.spec.ts`: vitest runs every `.spec.ts` and `.test.ts` file.
  testMatch: '*.e2e.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    // Locally, use the Chrome already installed. CI installs Playwright's own.
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `vite --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
  },
});
