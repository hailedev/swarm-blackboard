import { expect, test, type Locator, type Page } from '@playwright/test';

// Phase 4's smoke test: start a run, see entries appear, pause, inject, stop, and replay
// it, in a real browser against the server in `--fake` mode. Nothing is called or billed.

const card = (page: Page, handle: string): Locator =>
  page.locator(`[data-testid="entry-card"][data-handle="${handle}"]`);

/** The status of the open run, as its header shows it. */
const status = (page: Page): Locator =>
  page.getByTestId('run-page').getByTestId('run-status').first();

test('a run can be started, watched, steered and replayed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Team — blackboard swarm' })).toBeVisible();

  // Start a run from the dialog, on the default (free) profile.
  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByTestId('start-run-dialog');
  await expect(dialog.getByText('Models for “dev”')).toBeVisible();
  await expect(dialog.getByTestId('meter-dialog-month')).toBeVisible();
  await dialog.getByLabel('Problem').fill('Should we adopt a monorepo for our four teams?');
  await dialog.getByRole('button', { name: 'Start run' }).click();

  // The run is live: its problem is on the board under its handle, and entries appear.
  await expect(page.getByTestId('run-page')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await expect(card(page, 'P1')).toContainText('Should we adopt a monorepo for our four teams?');
  await expect(card(page, 'S1')).toBeVisible({ timeout: 15_000 });
  await expect(card(page, 'S2')).toBeVisible();
  await expect(page.getByTestId('live-feed')).toContainText('Round 1 completed');

  // Both gauges of the cost meter are there, with the run's cap and the month's limit.
  await expect(page.getByTestId('meter-run-cost')).toContainText('of $0.2500');
  await expect(page.getByTestId('meter-month-cost')).toContainText('of $5.00');

  // Pause: it takes effect after the round in flight, and the run says why it is paused.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'paused', { timeout: 15_000 });
  await expect(status(page)).toHaveAttribute('data-reason', 'user_paused');
  await expect(status(page)).toContainText('Paused — at your request');
  await expect(card(page, 'H1')).toBeVisible();
  await expect(page.getByTestId('live-feed')).toContainText('Paused — at your request');

  // Inject a note: it lands on the board as N1.
  await page.getByLabel('Note to the agents').fill('Prefer the option with the least risk.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(card(page, 'N1')).toContainText('Prefer the option with the least risk.');

  // Force a synthesis: the request is recorded and shown as owed.
  await page.getByRole('button', { name: 'Force synthesis' }).click();
  await expect(page.getByRole('button', { name: 'Synthesis requested' })).toBeDisabled();
  await expect(page.getByTestId('live-feed')).toContainText('You asked for a synthesis');

  // An entry opens with its provenance back to the problem.
  await card(page, 'H1').click();
  const detail = page.getByTestId('entry-detail');
  await expect(detail).toHaveAttribute('data-handle', 'H1');
  await expect(detail.getByTestId('provenance')).toContainText('P1');

  // Stop: the run ends and says why; there is nothing left to steer.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 15_000 });
  await expect(status(page)).toHaveAttribute('data-reason', 'user_stopped');
  await expect(status(page)).toContainText('Stopped — at your request');
  await expect(page.getByTestId('controls')).toContainText('This run has ended');

  // Replay: after a reload the run is in the list with its reason, and opens from the log.
  await page.reload();
  const row = page.getByTestId('run-row').first();
  await expect(row).toContainText('Stopped — at your request');
  await row.click();
  await expect(page.getByTestId('stream-state')).toHaveAttribute('data-stream', 'ended');
  await expect(card(page, 'N1')).toBeVisible();
  await expect(page.getByTestId('replay-position')).toContainText('2 rounds completed');

  // Scrub back to round 1: the board is as it stood then, before the hypothesis and the note.
  await page.getByLabel('Round', { exact: true }).fill('1');
  await expect(page.getByTestId('replay-banner')).toContainText('after round 1');
  await expect(card(page, 'S1')).toBeVisible();
  await expect(card(page, 'H1')).toHaveCount(0);
  await expect(card(page, 'N1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Latest' }).click();
  await expect(card(page, 'H1')).toBeVisible();

  // The trace has the scripted calls behind those rounds.
  await page.getByRole('tab', { name: /Trace/ }).click();
  await expect(page.locator('[data-testid="trace-table"] tbody tr')).toHaveCount(3);
});

test('a paid profile cannot start without an explicit yes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByTestId('start-run-dialog');
  await dialog.getByLabel('Problem').fill('Which database should we pick?');
  const start = dialog.getByRole('button', { name: 'Start run' });
  await expect(start).toBeEnabled();

  await dialog.getByRole('radio', { name: /cheap/ }).check();
  await expect(dialog.getByText('Models for “cheap”')).toBeVisible();
  await expect(start).toBeDisabled();
  const yes = dialog.getByLabel(/I understand this run calls paid models/);
  await yes.check();
  await expect(start).toBeEnabled();

  // A cap the month cannot absorb is refused before anything is sent.
  await dialog.getByLabel('Per-run cap (USD)').fill('9');
  await expect(dialog.getByRole('alert')).toContainText('This cap does not fit the month');
  await expect(start).toBeDisabled();

  // Back on the free profile nothing needs confirming.
  await dialog.getByRole('radio', { name: /dev/ }).check();
  await expect(yes).toHaveCount(0);
  await expect(start).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
