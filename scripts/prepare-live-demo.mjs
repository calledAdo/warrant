#!/usr/bin/env node
import 'dotenv/config';
import { prepareIntegratedS1Demo } from '../src/demo-live.js';

const result = await prepareIntegratedS1Demo();
console.log(JSON.stringify({
  mode: result.mode,
  scenario: result.scenario,
  customer_id: result.fixture.customer_id,
  email: result.fixture.email,
  charges: result.fixture.charges.map(charge => charge.id),
  incident: result.fixture.incident,
}, null, 2));
