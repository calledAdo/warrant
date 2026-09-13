#!/usr/bin/env node
import 'dotenv/config';
import { prepareS1Demo } from '../src/demo.js';

if (process.env.WARRANT_PROVIDER !== 'sqlite') {
  throw new Error('Set WARRANT_PROVIDER=sqlite to prepare the local S1 demo');
}

const demo = prepareS1Demo();
console.log(JSON.stringify({
  scenario: demo.scenario,
  customer: demo.customer,
  charges: demo.charges.map(charge => ({
    id: charge.id,
    amount: charge.amount,
    currency: charge.currency,
    amount_refunded: charge.amount_refunded,
  })),
}, null, 2));
