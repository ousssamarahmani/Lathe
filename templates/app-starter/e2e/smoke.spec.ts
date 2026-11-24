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
  const select = page.getByLabel('Active organization');
  await select.selectOption({ index: 1 });
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
}

test('a page without a session sends the visitor to sign-in', async ({ page }) => {
  await page.goto('/notes');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('wrong password shows an error and does not sign in', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(emailOf('a', 'owner'));
  await page.getByLabel('Password').fill('not-the-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('owner of org a creates a note; org b never sees it', async ({ browser }) => {
  const title = `E2E note ${Date.now()}`;

  const a = await browser.newPage();
  await signInAndChooseOrg(a, emailOf('a', 'owner'));
  await a.getByLabel('Title').fill(title);
  await a.getByRole('button', { name: 'Add note' }).click();
  const link = a.getByRole('link', { name: title });
  await expect(link).toBeVisible();
  await link.click();
  await expect(a).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  const noteUrl = a.url();
  await a.getByRole('link', { name: 'Members' }).click();
  await expect(a.getByRole('button', { name: 'Create invitation link' })).toBeVisible();

  const b = await browser.newPage();
  await signInAndChooseOrg(b, emailOf('b', 'owner'));
  await expect(b.getByRole('link', { name: title })).toHaveCount(0);
  await b.goto(noteUrl);
  await expect(b.getByText('Not found.')).toBeVisible();
  await expect(b.getByText(title)).toHaveCount(0);
});

test('a viewer sees notes but no form to create one, and no member controls', async ({ page }) => {
  await signInAndChooseOrg(page, emailOf('a', 'viewer'));
  await expect(page.getByRole('button', { name: 'Add note' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('button', { name: 'Create invitation link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});
