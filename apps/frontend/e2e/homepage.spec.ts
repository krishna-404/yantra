import { expect, test } from './fixtures';

test('homepage loads and redirects appropriately', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL((url) => url.pathname === '/auth/login' || url.pathname === '/dashboard');

  const currentURL = page.url();
  if (currentURL.includes('/auth/login')) {
    // Unauthenticated state: should redirect to login
    await expect(page.locator('h3')).toContainText('Welcome');
  } else if (currentURL.includes('/dashboard')) {
    // Authenticated state: should redirect to the dashboard
    await expect(page.locator('[aria-label*="User menu"]')).toBeVisible();
  }
});