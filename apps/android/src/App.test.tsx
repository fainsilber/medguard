import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

beforeEach(() => {
  localStorage.clear();
});

describe('App', () => {
  it('asks who is using the device before anything can be recorded', async () => {
    // Safety invariant 5: no anonymous entries. A default name baked into the app would
    // attribute a 3am dose to whoever the default happens to be, which reads as evidence.
    render(<App />);

    expect(screen.getByText(/who is using this device/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
  });

  it('refuses a blank name', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('enters the app once a caregiver identifies themselves, and remembers them', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    await user.type(screen.getByLabelText(/your name/i), 'Mom');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Caregiver: Mom')).toBeInTheDocument();

    unmount();
    render(<App />);
    expect(await screen.findByText('Caregiver: Mom')).toBeInTheDocument();
  });

  it('switches between sections', async () => {
    const user = userEvent.setup();
    localStorage.setItem('medguard-android-caregiver-name', 'Mom');
    render(<App />);

    await user.click(screen.getByRole('button', { name: /prn/i }));
    expect(await screen.findByText(/as needed \(prn\) safety/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /medicines/i }));
    expect(await screen.findByRole('button', { name: /add medicine/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /inventory/i }));
    expect(await screen.findByText(/inventory ledger/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /shabbat/i }));
    expect(
      await screen.findByRole('heading', { name: /motzei shabbat reconciliation/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /device/i }));
    expect(await screen.findByText(/device & household/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /today/i }));
    expect(await screen.findByText(/today’s schedule/i)).toBeInTheDocument();
  });

  it('marks the active tab for assistive technology', async () => {
    const user = userEvent.setup();
    localStorage.setItem('medguard-android-caregiver-name', 'Mom');
    render(<App />);

    const prn = screen.getByRole('button', { name: /prn/i });
    await user.click(prn);

    expect(prn).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /today/i })).not.toHaveAttribute('aria-current');
  });

  it('changes the caregiver from the device screen', async () => {
    const user = userEvent.setup();
    localStorage.setItem('medguard-android-caregiver-name', 'Mom');
    render(<App />);

    await user.click(screen.getByRole('button', { name: /device/i }));
    const input = await screen.findByLabelText(/caregiver name/i);
    await user.clear(input);
    await user.type(input, 'Dad');
    await user.click(screen.getByRole('button', { name: /save name/i }));

    expect(await screen.findByText('Caregiver: Dad')).toBeInTheDocument();
  });
});
