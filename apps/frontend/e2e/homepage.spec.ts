import { expect, test } from './fixtures';

test('homepage loads and redirects appropriately', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL((url) => url.pathname === '/auth/login' || url.pathname === '/projects');

  const currentURL = page.url();
  if (currentURL.includes('/auth/login')) {
    // Unauthenticated state: should redirect to login
    await expect(page.locator('h3')).toContainText('Welcome');
  } else if (currentURL.includes('/projects')) {
    // Authenticated state: the app lands on the projects shell
    await expect(page.locator('[aria-label*="User menu"]')).toBeVisible();
  }
});