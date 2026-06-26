const { test, expect } = require('@playwright/test');
const { baseUrls } = require('./helpers/env');

const specialTitle = 'Grüße "Tempo" \'Österreich\'';

test.describe('TITLE special characters', () => {
  test('modern page title supports umlauts and quotes', async ({ page }) => {
    await page.goto(`${baseUrls.standaloneNew}/index-modern.html`);
    await expect(page).toHaveTitle(`${specialTitle} - Speed test`);
    await expect(page.locator('main > h1')).toHaveText(specialTitle);
    await expect(page.locator('main > p.tagline')).toHaveCount(0);
  });

  test('classic heading supports umlauts and quotes', async ({ page }) => {
    await page.goto(`${baseUrls.standaloneNew}/index-classic.html`);
    await expect(page.locator('h1').first()).toHaveText(specialTitle);
  });

  test('modern page does not render a subtitle', async ({ page }) => {
    await page.goto(`${baseUrls.standaloneApostrophe}/index-modern.html`);
    await expect(page.locator('main > p.tagline')).toHaveCount(0);
  });
});
