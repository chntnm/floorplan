import { expect, test } from '@playwright/test';

test.describe('app shell', () => {
  test('boots and renders both panels and the viewport', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('roomplan')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Properties' })).toBeVisible();
    await expect(page.getByText('Plan view')).toBeVisible();
  });

  test('edit mode toggle locks and unlocks structure', async ({ page }) => {
    await page.goto('/');

    const plan = page.getByRole('button', { name: 'Edit floor plan' });
    const furnish = page.getByRole('button', { name: 'Arrange furniture' });

    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Walls, rooms and openings are editable.')).toBeVisible();

    await furnish.click();

    await expect(furnish).toHaveAttribute('aria-pressed', 'true');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByText('Structure is locked; furniture is editable.'),
    ).toBeVisible();
  });

  test('view toggle switches between the plan and space renderers', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Space', exact: true }).click();

    await expect(page.getByText('Space view')).toBeVisible();
    await expect(page.getByText(/arrow-key traversal/)).toBeVisible();
  });
});
