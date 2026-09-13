import Stripe from 'stripe';

let client;
const stripe = () => (client ??= new Stripe(process.env.STRIPE_SECRET_KEY));

export async function createSimulatedPayment() {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    throw new Error('The payment simulation requires a Stripe test-mode key');
  }
  const email = 'billing@northwind.test';
  const customer = await stripe().customers.create({
    name: 'Northwind Trading Co. (PAYMENT DEMO)',
    email,
    metadata: { warrant_fixture: 'true', scenario: 'payment-s1' },
  });
  const charges = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const intent = await stripe().paymentIntents.create({
      amount: 4900,
      currency: 'usd',
      customer: customer.id,
      description: 'Invoice SEP-2026 - Pro plan',
      payment_method: 'pm_card_visa',
      confirm: true,
      payment_method_types: ['card'],
      metadata: { warrant_fixture: 'true', scenario: 'payment-s1', attempt: String(attempt) },
    });
    charges.push({ id: intent.latest_charge, created: intent.created, amount: 4900, currency: 'usd' });
  }
  return { customer: { id: customer.id, name: customer.name, email }, charges };
}
