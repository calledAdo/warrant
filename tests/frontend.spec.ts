import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function scenario(request: APIRequestContext, name = 'review', failure?: string) { await request.post('/__test/scenario', { data: { name, failure } }); }
async function fillReport(page: Page) { await page.getByLabel('Account email').fill('billing@northwind.test'); await page.getByLabel('What happened?').fill('Two $49 charges appeared on my statement.'); }
async function openAdmin(page: Page) { await page.goto('/admin'); await expect(page.getByRole('heading', { name: 'Northwind Studio', exact: true })).toBeVisible(); await expect(page.getByText('Live updates', { exact: true })).toBeVisible(); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
test.beforeEach(async ({ request }) => { await scenario(request); });

test('landing workflow animates evidence, supports pause, and keeps the live map separate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const workflow = page.getByRole('region', { name: 'Illustrated refund workflow' });
  await expect(workflow.getByRole('heading', { name: 'Read the billing evidence' })).toBeVisible();
  const pulse = workflow.locator('.flow-pulse');
  await expect(pulse).toHaveCount(1);
  const offset = await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset);
  await expect.poll(() => pulse.evaluate(node => getComputedStyle(node).strokeDashoffset)).not.toBe(offset);
  await page.clock.install();
  await workflow.getByRole('button', { name: 'Pause workflow animation' }).click();
  await expect(pulse).toHaveCount(0);
  await page.clock.fastForward(20000);
  await expect(workflow.getByRole('heading', { name: 'Read the billing evidence' })).toBeVisible();
  await workflow.getByRole('button', { name: 'Play workflow animation' }).click();
  await page.clock.runFor(3300);
  await expect(workflow.getByRole('heading', { name: 'Look for a matching incident' })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Northwind Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Illustrated refund workflow' })).toHaveCount(0);
  await expect(page.locator('.flow-pulse')).toHaveCount(0);
  await expect(page.locator('.integration-waiting')).toContainText('Awaiting your decision');
});

test('reduced-motion walkthrough gates the illustrated refund behind approval and makes no API calls', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.clock.install();
  const workflow = page.getByRole('region', { name: 'Illustrated refund workflow' });
  const next = workflow.getByRole('button', { name: 'Next workflow step' });
  await expect(workflow.locator('.flow-pulse')).toHaveCount(0);
  await expect(workflow.getByRole('button', { name: /workflow animation/ })).toHaveCount(0);
  await page.clock.fastForward(60000);
  await expect(workflow.getByRole('heading', { name: 'Read the billing evidence' })).toBeVisible();
  for (const title of ['Look for a matching incident', 'Check the finding against policy', 'Write a cited case', 'Send the proposal to the team', 'Wait for a person’s decision']) {
    await next.click();
    await expect(workflow.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(workflow).toContainText('No refund can proceed without approval.');
  await expect(workflow.locator('.integration-waiting')).toContainText('Human review');
  await page.clock.fastForward(60000);
  await expect(workflow.getByRole('heading', { name: 'Wait for a person’s decision' })).toBeVisible();
  for (const title of ['If the reviewer approves', 'Recheck before moving money', 'Issue one full refund', 'Verify the refunded amount', 'Close the loop']) {
    await next.click();
    await expect(workflow.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(workflow).toContainText('If evidence is insufficient or approval is declined, no money moves.');
  await next.click();
  await expect(workflow.getByRole('heading', { name: 'Read the billing evidence' })).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('report validates, preserves input after failure, and tracks a successful retry', async ({ page, request }) => {
  await scenario(request, 'review', 'report'); await page.goto('/');
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByLabel('Account email')).toBeFocused();
  await expect(page.getByText('Enter a valid account email address.')).toBeVisible();
  await fillReport(page); await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('What happened?')).toHaveValue('Two $49 charges appeared on my statement.');
  await expect(page.getByRole('button', { name: 'Submit report', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page).toHaveURL(/ref=C-TEST1/); await expect(page.getByText('C-TEST1', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Checking the evidence', { exact: true })).toBeVisible();
  await expect(page.locator('.original-report')).toContainText('Two $49 charges');
});

test('network failure releases the report form without clearing the report', async ({ page }) => {
  await page.route('**/api/complaints', route => route.abort('failed')); await page.goto('/'); await fillReport(page);
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not connect');
  await expect(page.getByRole('button', { name: 'Submit report', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Account email')).toHaveValue('billing@northwind.test');
});

test('tracking dialog is keyboard accessible and invalid references have a recovery state', async ({ page }) => {
  await page.goto('/'); const trigger = page.getByRole('button', { name: 'Track a report', exact: true });
  await trigger.click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Report reference').fill('C-NONEX'); await page.getByRole('button', { name: 'Track report', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('couldn’t find that reference');
  await page.goto('/'); await trigger.click(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('verified refund outcome does not expose internal provider identifiers', async ({ page, request }) => {
  await scenario(request, 'customer_complete'); await page.goto('/?ref=C-TEST1');
  await expect(page.getByRole('heading', { name: '$49.00 refunded' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ch_duplicate'); await expect(page.locator('body')).not.toContainText('wpl_');
});

test('queue search, filters, and same-status case switching keep evidence attached to the correct case', async ({ page, request }) => {
  await scenario(request, 'same_status'); await openAdmin(page);
  await page.getByRole('button', { name: /Harbor & Co\./ }).click();
  await expect(page.getByRole('heading', { name: 'Harbor & Co.', exact: true })).toBeVisible();
  await expect(page.getByText('Harbor evidence only.', { exact: false })).toBeVisible();
  await expect(page.locator('.refund-amount')).toContainText('$73.00');
  await page.getByRole('button', { name: /Northwind Studio.*Just|Northwind Studio.*ago/ }).click();
  await expect(page.locator('.refund-amount')).toContainText('$49.00');
  await expect(page.getByText('Harbor evidence only.', { exact: false })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('no-such-customer');
  await expect(page.getByRole('heading', { name: 'No matching reports' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('Northwind');
  await expect(page.locator('.queue-item')).toHaveCount(1);
});

test('approval is confirmed by a person, bound to the displayed plan, and recovers from a rejection', async ({ page, request }) => {
  await scenario(request, 'review', 'approve'); await openAdmin(page);
  await page.getByRole('button', { name: 'Approve refund', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ch_duplicate_123456789');
  await page.getByLabel('Your work email').fill('reviewer@example.test');
  await page.getByRole('button', { name: 'Confirm $49.00 refund', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('plan changed');
  await expect(page.getByRole('button', { name: 'Confirm $49.00 refund', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm $49.00 refund', exact: true }).click();
  await expect(page.getByRole('heading', { name: '$49.00 refunded and verified' })).toBeVisible();
  const result = await (await request.get('/__test/actions')).json();
  expect(result.actions).toHaveLength(2);
  expect(result.actions[1]).toMatchObject({ action: 'approve', run_id: 'run_northwind', plan_id: 'wpl_test_exact_plan', approver: 'reviewer@example.test' });
  await page.getByRole('tab', { name: 'Activity & audit' }).click();
  await expect(page.getByText('Full refund', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /GitHub case file/ })).toHaveAttribute('href', 'https://github.com/example/billing/issues/42');
});

test('decline requires a recorded reason and records no refund', async ({ page, request }) => {
  await openAdmin(page); await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.getByLabel('Your work email').fill('reviewer@example.test');
  await page.getByRole('button', { name: 'Confirm decline' }).click();
  await expect(page.getByRole('alert')).toContainText('Add a reason');
  await page.getByLabel('Reason for declining').fill('The customer confirmed both charges were intended.');
  await page.getByRole('button', { name: 'Confirm decline' }).click();
  await expect(page.getByRole('heading', { name: 'Refund declined' })).toBeVisible();
  const result = await (await request.get('/__test/actions')).json();
  expect(result.actions).toEqual([expect.objectContaining({ action: 'decline', reason: 'The customer confirmed both charges were intended.' })]);
});

test('expired approval cannot be submitted, including when it expires with the dialog open', async ({ page, request }) => {
  await scenario(request, 'expired'); await openAdmin(page);
  await expect(page.getByRole('button', { name: 'Approve refund', exact: true })).toBeDisabled();
  await scenario(request, 'review'); await page.reload(); await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve refund', exact: true }).click();
  await page.clock.install(); await page.clock.fastForward(16 * 60000);
  await expect(page.getByRole('button', { name: 'Confirm $49.00 refund', exact: true })).toBeDisabled();
  const result = await (await request.get('/__test/actions')).json(); expect(result.actions).toHaveLength(0);
});

test('follow-up retry preserves the refund and only calls resume', async ({ page, request }) => {
  await scenario(request, 'partial'); await openAdmin(page);
  await expect(page.getByRole('heading', { name: 'Refund issued. Follow-up pending.' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry follow-up' }).click();
  await expect(page.getByRole('heading', { name: '$49.00 refunded and verified' })).toBeVisible();
  const result = await (await request.get('/__test/actions')).json(); expect(result.actions).toEqual([{ action: 'resume', run_id: 'run_northwind' }]);
});

test('queue outage and missing run are visible rather than empty or permanently loading', async ({ page, request }) => {
  await scenario(request, 'queue_error'); await page.goto('/admin'); await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await scenario(request, 'missing_run'); await page.reload();
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Approve refund', exact: true })).toHaveCount(0);
});

test('desktop pages are accessible and produce review screenshots', async ({ page, request }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByRole('heading', { name: /Unexpected charge/ })).toBeVisible(); await page.evaluate(() => document.fonts.ready);
  await noOverflow(page); await page.screenshot({ path: testInfo.outputPath('customer-desktop.png'), fullPage: true });
  const customer = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await testInfo.attach('customer-accessibility.json', { body: JSON.stringify(customer.violations, null, 2), contentType: 'application/json' });
  expect(customer.violations).toEqual([]);
  await openAdmin(page); await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png'), fullPage: true }); await noOverflow(page);
  const admin = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await testInfo.attach('workspace-accessibility.json', { body: JSON.stringify(admin.violations, null, 2), contentType: 'application/json' });
  expect(admin.violations).toEqual([]); expect(errors).toEqual([]);
  await scenario(request, 'empty'); await page.reload(); await expect(page.getByRole('heading', { name: 'Good decisions start with evidence.' })).toBeVisible();
});

test('mobile report and case flows fit small viewports and respect reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await noOverflow(page); await expect(page.getByLabel('Account email')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('customer-mobile.png'), fullPage: true });
  await page.goto('/admin'); await page.getByRole('button', { name: /Northwind Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Northwind Studio', exact: true })).toBeVisible(); await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '← All reports' }).click(); await expect(page.getByRole('searchbox', { name: 'Search reports' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 }); await noOverflow(page);
});
