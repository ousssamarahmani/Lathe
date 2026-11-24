import { expect, test, type Page } from '@playwright/test';
import { SEED_PRINCIPALS } from '../src/server/seed-data';

const password = (): string => {
  const value = process.env['LATHE_TEST_PASSWORD'];
  if (!value) throw new Error('LATHE_TEST_PASSWORD is set by playwright.config.ts');
  return value;
};
const emailOf = (org: 'a' | 'b', role: string): string => {
  const p = SEED_PRINCIPALS.find((x) => x.org === org && x.role === role);
  if (!p) throw new Error(`no seed principal ${org}/${role}`);
  return p.email;
};

async function signInAndChooseOrg(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose an organization' })).toBeVisible();
  await page.getByLabel('Active organization').selectOption({ index: 1 });
  await expect(page.getByRole('heading', { name: /Tickets|My tickets/ })).toBeVisible();
}

test('a page without a session sends the visitor to sign-in', async ({ page }) => {
  await page.goto('/tickets');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('a requester opens a ticket; staff reply with an internal note the requester never sees', async ({
  browser,
}) => {
  const title = `E2E ticket ${Date.now()}`;
  const note = `internal ${Date.now()}`;

  const requester = await browser.newPage();
  await signInAndChooseOrg(requester, emailOf('a', 'requester'));
  await expect(requester.getByRole('heading', { name: 'My tickets' })).toBeVisible();
  await expect(requester.getByLabel('Priority')).toHaveCount(0);
  await requester.getByLabel('Subject').fill(title);
  await requester.getByRole('button', { name: 'Open ticket' }).click();
  await requester.getByRole('link', { name: title }).click();
  await expect(requester).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  const ticketUrl = requester.url();
  await expect(requester.getByRole('region', { name: 'Ticket controls' })).toHaveCount(0);

  const agent = await browser.newPage();
  await signInAndChooseOrg(agent, emailOf('a', 'agent'));
  await agent.getByRole('link', { name: title }).click();
  await expect(agent.getByRole('region', { name: 'Ticket controls' })).toBeVisible();
  await agent.getByLabel('Reply').fill(note);
  await agent.getByLabel('Internal note (staff only)').check();
  await agent.getByRole('button', { name: 'Add reply' }).click();
  await expect(agent.getByText(note)).toBeVisible();
  await agent.getByLabel('Status').selectOption('pending');
  await expect(agent.getByText(/pending · normal/)).toBeVisible();

  await requester.goto(ticketUrl);
  await expect(requester.getByText(/pending · normal/)).toBeVisible();
  await expect(requester.getByText(note)).toHaveCount(0);
});

test("org b never sees org a's tickets, in the list or by URL", async ({ browser }) => {
  const title = `E2E isolation ${Date.now()}`;
  const a = await browser.newPage();
  await signInAndChooseOrg(a, emailOf('a', 'agent'));
  await a.getByLabel('Subject').fill(title);
  await a.getByRole('button', { name: 'Open ticket' }).click();
  await a.getByRole('link', { name: title }).click();
  await expect(a).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  const url = a.url();

  const b = await browser.newPage();
  await signInAndChooseOrg(b, emailOf('b', 'owner'));
  await expect(b.getByRole('link', { name: title })).toHaveCount(0);
  await b.goto(url);
  await expect(b.getByText('Not found.')).toBeVisible();
  await expect(b.getByText(title)).toHaveCount(0);
});
