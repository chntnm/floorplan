import { expect, test, type Page } from '@playwright/test';

/**
 * Product URL import — PLAN.md §7.2.
 *
 * This suite runs against `vite preview`, which serves the production build and has
 * **no** `/api/product-lookup`: the dev middleware is registered in `configureServer`
 * only, and production deploys the endpoint as a separate serverless function. So the
 * degradation case here is a real absence rather than a stub of one, which is the
 * point — §7.2 requires the app to stay fully functional as a static build with the
 * endpoint gone.
 *
 * The success path is driven by stubbing `window.fetch`, the same shape as the save
 * picker stub, and for the same reason: the client reads `fetch` off `globalThis` at
 * call time rather than capturing it at module load.
 */

const SOFA = {
  url: 'https://shop.example.com/p/harlow-sofa',
  draft: {
    name: 'Harlow Sofa',
    widthMm: 2134,
    depthMm: 965,
    heightMm: 813,
    confidence: 'labelled',
    rawSnippet: 'Width: 84 in · Depth: 38 in · Height: 32 in',
    dimensionSource: 'json-ld',
  },
};

async function stubLookup(page: Page, body: unknown, status = 200): Promise<void> {
  await page.evaluate(
    ({ body: payload, status: code }) => {
      window.fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: code,
            headers: { 'content-type': 'application/json' },
          }),
        );
    },
    { body, status },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.describe('with no lookup service', () => {
  test('says so and points at manual entry', async ({ page }) => {
    // No stub: this is the production build talking to a host that has no endpoint.
    // A static deploy answers an unknown POST with the SPA shell and a 200, which is
    // exactly the case `response.ok` would get wrong.
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill('https://shop.example.com/p/sofa');
    await page.getByTestId('lookup-go').click();

    const error = page.getByTestId('inventory-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('by hand');
    // No half-open dialog left behind claiming a product was found.
    await expect(page.getByTestId('lookup-confirm')).toBeHidden();
  });

  test('leaves manual entry working', async ({ page }) => {
    // "The app remains fully functional as a static build with the endpoint absent."
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill('https://shop.example.com/p/sofa');
    await page.getByTestId('lookup-go').click();
    await expect(page.getByTestId('inventory-error')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Hand-typed sofa');
    await page.getByLabel('Width').fill('2000mm');
    await page.getByLabel('Depth').fill('900mm');
    await page.getByLabel('Height').fill('800mm');
    await page.getByTestId('item-form').getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByText('Hand-typed sofa')).toBeVisible();
  });
});

test.describe('confirm before add', () => {
  test('shows the page it read and the text the numbers came from', async ({ page }) => {
    await stubLookup(page, SOFA);
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill(SOFA.url);
    await page.getByTestId('lookup-go').click();

    await expect(page.getByTestId('lookup-confirm')).toBeVisible();
    await expect(page.getByTestId('lookup-url')).toHaveText(SOFA.url);
    // §7.2: a scraped dimension a person cannot check against the page is one they
    // have to take on trust, which is what this dialog exists to prevent.
    await expect(page.getByTestId('lookup-evidence')).toContainText('84 in');

    // Every field editable, and pre-filled with what was found — formatted in the
    // document's display unit, never as bare millimetres, or the form would read
    // "2134" back as 2134 inches. 2134mm is 84", which is 7' 0".
    await expect(page.getByLabel('Item name')).toHaveValue('Harlow Sofa');
    await expect(page.getByLabel('Width')).toHaveValue(`7' 0"`);
  });

  test('adds the item, flagged as carrying a number nobody checked', async ({ page }) => {
    await stubLookup(page, SOFA);
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill(SOFA.url);
    await page.getByTestId('lookup-go').click();
    await page.getByTestId('item-form').getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByText('Harlow Sofa')).toBeVisible();
    await expect(page.getByTestId('lookup-confirm')).toBeHidden();
    await expect(page.getByText('unverified')).toBeVisible();
  });

  test('drops the flag once the dimensions have been typed over', async ({ page }) => {
    // The flag means "this item carries a measurement nobody checked". A number the
    // user corrected has been checked against something.
    await stubLookup(page, SOFA);
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill(SOFA.url);
    await page.getByTestId('lookup-go').click();

    await page.getByLabel('Width').fill('2100mm');
    await page.getByLabel('Depth').fill('950mm');
    await page.getByLabel('Height').fill('820mm');
    await page.getByTestId('item-form').getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByText('Harlow Sofa')).toBeVisible();
    await expect(page.getByText('unverified')).toBeHidden();
  });

  test('says when a page had no dimensions at all', async ({ page }) => {
    // An OpenGraph-only page. Half a draft is still worth having — the form opens
    // named, and the measurements are left to the user rather than invented.
    await stubLookup(page, {
      url: 'https://shop.example.com/p/wren',
      draft: { name: 'Wren Armchair' },
    });
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill('https://shop.example.com/p/wren');
    await page.getByTestId('lookup-go').click();

    await expect(page.getByTestId('lookup-evidence')).toContainText('did not state any dimensions');
    await expect(page.getByLabel('Item name')).toHaveValue('Wren Armchair');
    await expect(page.getByLabel('Width')).toHaveValue('');
  });

  test('shows the endpoint refusal, not the absent-endpoint advice', async ({ page }) => {
    // Two different things: "your URL is wrong" is the user's to fix, and telling them
    // to type it in by hand instead would be answering a question they did not ask.
    await stubLookup(page, { message: 'Only https product pages can be looked up.' }, 400);
    await page.getByTestId('add-from-url').click();
    await page.getByTestId('lookup-url-input').fill('http://shop.example.com/p/sofa');
    await page.getByTestId('lookup-go').click();

    const error = page.getByTestId('inventory-error');
    await expect(error).toContainText('Only https');
    await expect(error).not.toContainText('by hand');
  });
});
