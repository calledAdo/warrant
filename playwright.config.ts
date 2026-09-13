import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results',
  timeout: 30000, retries: 0, reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1100 },
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: { command: 'node tests/mock-server.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 15000 },
});
