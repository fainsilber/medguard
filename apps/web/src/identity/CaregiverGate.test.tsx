import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaregiverGate } from './CaregiverGate.js';
import { getCaregiverName, setCaregiverName } from './caregiverName.js';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

function renderGate() {
  return render(
    <CaregiverGate>
      <div>App content</div>
    </CaregiverGate>,
  );
}

/**
 * A fresh device is offered a household first. These tests mostly exercise the path *after* that
 * choice, so they take the standalone option and then assert on name capture.
 */
async function chooseStandalone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Use this device on its own for now' }));
}

describe('CaregiverGate', () => {
  it('offers a household before anything else on a brand-new device', () => {
    renderGate();

    expect(screen.getByRole('button', { name: 'Start a new household' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join with a code' })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('lets a caregiver decline a household and carry on alone — offline must never be blocked', async () => {
    const user = userEvent.setup();
    renderGate();

    await chooseStandalone(user);

    expect(screen.getByRole('textbox', { name: /your name/i })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('renders children directly when a name is already stored', () => {
    setCaregiverName('Mom');
    renderGate();

    expect(screen.getByText('App content')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /your name/i })).not.toBeInTheDocument();
  });

  it('stores the name and unlocks the app on submit', async () => {
    const user = userEvent.setup();
    renderGate();
    await chooseStandalone(user);

    await user.type(screen.getByRole('textbox', { name: /your name/i }), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('App content')).toBeInTheDocument();
    expect(getCaregiverName()).toBe('Dad');
  });

  it('rejects a blank submission without unlocking the app', async () => {
    const user = userEvent.setup();
    renderGate();
    await chooseStandalone(user);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
    expect(getCaregiverName()).toBeNull();
  });

  it('clears the error once the caregiver starts typing again', async () => {
    const user = userEvent.setup();
    renderGate();
    await chooseStandalone(user);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /your name/i }), 'M');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
