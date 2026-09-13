import { seedS1Provider, resetDemoProvider, demoStatus, sqliteProviderEnabled } from './demo-store.js';
import { reset as resetJournal } from './journal.js';
import { resetRuns } from './runstate.js';
import * as complaints from './complaints.js';

export function ensureS1Demo() {
  if (!sqliteProviderEnabled()) throw new Error('SQLite demo provider is not enabled');
  return seedS1Provider();
}

export function prepareS1Demo() {
  if (!sqliteProviderEnabled()) throw new Error('Demo reset is available only with WARRANT_PROVIDER=sqlite');
  resetJournal();
  complaints.reset();
  resetRuns();
  resetDemoProvider();
  return seedS1Provider();
}

export function getS1Demo() {
  if (!sqliteProviderEnabled()) return { mode: 'live', scenario: null };
  return demoStatus();
}
