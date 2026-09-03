import { expect, test } from '@playwright/test';

test.describe('app shell', () => {
  test('boots and renders both panels and the plan editor', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('floorplan')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Properties' })).toBeVisible();

    // The Konva stage replaced the phase-0 placeholder card.
    await expect(page.getByTestId('plan-stage')).toBeVisible();
    await expect(page.getByTestId('plan-stage').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('count-walls')).toContainText('0');
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

    // The 3D chunk is loaded on demand, so the view arrives a moment after the click.
    await expect(page.getByTestId('space-view')).toBeVisible();
    await expect(page.getByTestId('hud-help')).toBeVisible();
    await expect(page.getByTestId('plan-stage')).toHaveCount(0);

    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(page.getByTestId('plan-stage')).toBeVisible();
    await expect(page.getByTestId('space-view')).toHaveCount(0);
  });
});
