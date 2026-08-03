import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Leaving a household, revoking a device, and deleting a household — the four pieces added
 * alongside join-code onboarding. Runs against a stubbed API, like household-join.spec.ts: every
 * route here is already proven against the real workerd runtime and real D1 in
 * apps/api/tests/household-lifecycle.test.ts. What has no coverage without this is the browser
 * half — the two-device scenario in particular, where revoking a device from one browser context
 * has to actually cut the *other* context off.
 *
 * Unlike household-join.spec.ts's per-page stub, this one shares its fake backend state across
 * both browser contexts in the same test: `page.route` handlers run in the Node process, so a
 * plain object closed over by both contexts' route registrations genuinely behaves like one
 * shared server, which is what a real two-device revoke actually needs to prove.
 */

interface FakeDevice {
  id: string;
  token: string;
  displayName: string;
}

function createFakeBackend() {
  const devices = new Map<string, FakeDevice>(); // token -> device
  let nextDeviceId = 1;
  let pendingCode: string | null = null;
  const householdId = 'household-1';
  const householdName = 'The Cohens';

  function deviceForToken(token: string | null): FakeDevice | undefined {
    return token ? devices.get(token) : undefined;
  }

  return { devices, householdId, householdName, deviceForToken, issueCode: () => (pendingCode = '482913'), get pendingCode() { return pendingCode; }, clearCode: () => (pendingCode = null), nextId: () => `device-${nextDeviceId++}` };
}

async function registerRoutes(page: Page, backend: ReturnType<typeof createFakeBackend>) {
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const auth = req.headers()['authorization'];
    const token = auth?.replace(/^Bearer\s+/i, '') ?? null;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/v1/time')) {
      return json({ nowIso: new Date().toISOString(), nowMs: Date.now() });
    }

    if (url.includes('/api/v1/households') && req.method() === 'POST') {
      const deviceId = backend.nextId();
      const deviceToken = `token-${deviceId}`;
      backend.devices.set(deviceToken, { id: deviceId, token: deviceToken, displayName: 'Mom' });
      return json(
        { deviceToken, householdId: backend.householdId, householdName: backend.householdName, userId: 'user-mom', deviceId },
        201,
      );
    }

    if (url.includes('/join-codes/redeem')) {
      const body = req.postDataJSON() as { code: string; displayName: string };
      if (body.code !== backend.pendingCode) {
        return json({ error: 'invalid_code' }, 400);
      }
      backend.clearCode();
      const deviceId = backend.nextId();
      const deviceToken = `token-${deviceId}`;
      backend.devices.set(deviceToken, { id: deviceId, token: deviceToken, displayName: body.displayName });
      return json(
        {
          deviceToken,
          householdId: backend.householdId,
          householdName: backend.householdName,
          userId: `user-${deviceId}`,
          deviceId,
        },
        201,
      );
    }

    if (url.includes('/join-codes') && req.method() === 'POST') {
      backend.issueCode();
      return json({ code: backend.pendingCode, expiresAt: 'later', expiresInSeconds: 900 }, 201);
    }

    const caller = backend.deviceForToken(token);
    if (!caller) {
      return json({ error: 'unauthorized' }, 401);
    }

    if (url.includes('/api/v1/me')) {
      return json({
        householdId: backend.householdId,
        householdName: backend.householdName,
        userId: `user-${caller.id}`,
        displayName: caller.displayName,
        deviceId: caller.id,
      });
    }

    if (url.endsWith('/api/v1/devices')) {
      return json({
        devices: Array.from(backend.devices.values()).map((d) => ({
          id: d.id,
          platform: null,
          createdAt: '2026-08-03T10:00:00.000Z',
          lastSeenAt: '2026-08-03T10:00:00.000Z',
          userId: `user-${d.id}`,
          displayName: d.displayName,
          isThisDevice: d.id === caller.id,
        })),
      });
    }

    const revokeMatch = /\/api\/v1\/devices\/(.+)$/.exec(url);
    if (revokeMatch && req.method() === 'DELETE') {
      const targetId = decodeURIComponent(revokeMatch[1]!);
      const entry = Array.from(backend.devices.entries()).find(([, d]) => d.id === targetId);
      if (!entry) return json({ error: 'not_found' }, 404);
      backend.devices.delete(entry[0]);
      return json({ ok: true });
    }

    if (url.includes('/api/v1/leave')) {
      backend.devices.delete(caller.token);
      return json({ ok: true });
    }

    if (url.includes('/api/v1/households') && req.method() === 'DELETE') {
      backend.devices.clear();
      return json({ ok: true });
    }

    return json({ error: 'not_found' }, 404);
  });
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
}

test('revoking a device from one browser cuts the other one off', async ({ browser }) => {
  const backend = createFakeBackend();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await registerRoutes(pageA, backend);
  await signIn(pageA);

  await pageA.getByRole('button', { name: 'Start a new household' }).click();
  await pageA.getByLabel('Household name').fill('The Cohens');
  await pageA.getByLabel('Your name').fill('Mom');
  await pageA.getByRole('button', { name: 'Create household' }).click();
  await expect(pageA.getByText(/Connected to The Cohens/)).toBeVisible();

  await pageA.getByRole('button', { name: 'Invite another caregiver' }).click();
  await expect(pageA.getByText('482913')).toBeVisible();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await registerRoutes(pageB, backend);
  await signIn(pageB);

  await pageB.getByRole('button', { name: 'Join with a code' }).click();
  await pageB.getByLabel('Join code').fill('482913');
  await pageB.getByLabel('Your name').fill('Dad');
  await pageB.getByRole('button', { name: 'Join household' }).click();
  await expect(pageB.getByText(/Connected to The Cohens/)).toBeVisible();

  // A's device list now shows both — the shared fake backend actually saw both joins.
  await pageA.reload();
  await pageA.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
  await expect(pageA.getByText('Dad')).toBeVisible();

  await pageA.getByRole('button', { name: 'Revoke' }).click();
  await expect(pageA.getByText('Dad')).not.toBeVisible();

  // B's device is now cut off — the next authenticated call it makes fails.
  const meStatus = await pageB.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem('medguard-household-session') ?? '{}').deviceToken;
    const response = await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    return response.status;
  });
  expect(meStatus).toBe(401);

  await contextA.close();
  await contextB.close();
});

test('leaving a household clears local data and returns to onboarding', async ({ page }) => {
  const backend = createFakeBackend();
  await registerRoutes(page, backend);
  await signIn(page);

  await page.getByRole('button', { name: 'Start a new household' }).click();
  await page.getByLabel('Household name').fill('The Cohens');
  await page.getByLabel('Your name').fill('Mom');
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText(/Connected to The Cohens/)).toBeVisible();

  // Add a medicine so there is local data for leaving to actually clear.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Ondansetron');
  await page.getByLabel('Strength').fill('4mg');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Ondansetron', { exact: false })).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
  await page.getByRole('button', { name: 'Leave this household' }).click();
  await page.getByRole('button', { name: 'Leave household' }).click();
  await expect(page.getByText(/isn.t connected to a household/)).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Medicines' }).click();
  await expect(page.getByText('No medicines yet.')).toBeVisible();
});

test('deleting a household requires typing DELETE and returns to onboarding', async ({ page }) => {
  const backend = createFakeBackend();
  await registerRoutes(page, backend);
  await signIn(page);

  await page.getByRole('button', { name: 'Start a new household' }).click();
  await page.getByLabel('Household name').fill('The Cohens');
  await page.getByLabel('Your name').fill('Mom');
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText(/Connected to The Cohens/)).toBeVisible();

  await page.getByRole('button', { name: 'Delete this household' }).click();
  const confirmButton = page.getByRole('button', { name: 'Delete household' });
  await expect(confirmButton).toBeDisabled();

  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByText(/isn.t connected to a household/)).toBeVisible();
});
