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

describe('CaregiverGate', () => {
  it('shows the name capture form when no name is stored', () => {
    render(
      <CaregiverGate>
        <div>App content</div>
      </CaregiverGate>,
    );

    expect(screen.getByRole('textbox', { name: /your name/i })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('renders children directly when a name is already stored', () => {
    setCaregiverName('Mom');

    render(
      <CaregiverGate>
        <div>App content</div>
      </CaregiverGate>,
    );

    expect(screen.getByText('App content')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /your name/i })).not.toBeInTheDocument();
  });

  it('stores the name and unlocks the app on submit', async () => {
    const user = userEvent.setup();
    render(
      <CaregiverGate>
        <div>App content</div>
      </CaregiverGate>,
    );

    await user.type(screen.getByRole('textbox', { name: /your name/i }), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('App content')).toBeInTheDocument();
    expect(getCaregiverName()).toBe('Dad');
  });

  it('rejects a blank submission without unlocking the app', async () => {
    const user = userEvent.setup();
    render(
      <CaregiverGate>
        <div>App content</div>
      </CaregiverGate>,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
    expect(getCaregiverName()).toBeNull();
  });

  it('clears the error once the caregiver starts typing again', async () => {
    const user = userEvent.setup();
    render(
      <CaregiverGate>
        <div>App content</div>
      </CaregiverGate>,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /your name/i }), 'M');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
