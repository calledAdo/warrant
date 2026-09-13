import { prepareLiveS1Demo } from '../fixtures/build.mjs';
import { reset as resetJournal } from './journal.js';
import { resetRuns } from './runstate.js';
import * as complaints from './complaints.js';

export async function prepareIntegratedS1Demo() {
  const fixture = await prepareLiveS1Demo();
  resetJournal();
  complaints.reset();
  resetRuns();
  return { mode: 'live', scenario: 's1', fixture };
}
