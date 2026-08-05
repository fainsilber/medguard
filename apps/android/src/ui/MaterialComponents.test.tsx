import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { M3Badge, M3Card, M3TopAppBar } from './MaterialComponents.js';

describe('M3Card', () => {
  it('is a plain container when it is not tappable', () => {
    render(<M3Card>content</M3Card>);

    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is a real button when it is tappable, so a keyboard can reach it', () => {
    // A div with an onClick is unreachable by keyboard and invisible to a screen reader — and
    // on the Shabbat screen the tappable card *is* how a dose gets confirmed.
    const onClick = vi.fn();
    render(<M3Card onClick={onClick}>tap me</M3Card>);

    expect(screen.getByRole('button', { name: 'tap me' })).toBeInTheDocument();
  });

  it('fires on keyboard activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<M3Card onClick={onClick}>tap me</M3Card>);

    await user.tab();
    await user.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('merges caller classes', () => {
    render(<M3Card className="border-sky-500">content</M3Card>);
    expect(screen.getByText('content').className).toContain('border-sky-500');
  });
});

describe('M3Badge', () => {
  it('renders each tone', () => {
    render(
      <>
        <M3Badge tone="safe">Safe</M3Badge>
        <M3Badge tone="locked">Locked</M3Badge>
        <M3Badge tone="capped">Capped</M3Badge>
        <M3Badge tone="neutral">Neutral</M3Badge>
        <M3Badge tone="info">Info</M3Badge>
      </>,
    );

    expect(screen.getByText('Safe').className).toContain('emerald');
    expect(screen.getByText('Locked').className).toContain('rose');
    expect(screen.getByText('Capped').className).toContain('amber');
    expect(screen.getByText('Neutral').className).toContain('slate');
    expect(screen.getByText('Info').className).toContain('sky');
  });
});

describe('M3TopAppBar', () => {
  it('renders the title alone', () => {
    render(<M3TopAppBar title="MedGuard" />);

    expect(screen.getByRole('heading', { name: 'MedGuard' })).toBeInTheDocument();
  });

  it('renders a subtitle and actions when given them', () => {
    render(
      <M3TopAppBar title="MedGuard" subtitle="Caregiver: Mom" actions={<span>action</span>} />,
    );

    expect(screen.getByText('Caregiver: Mom')).toBeInTheDocument();
    expect(screen.getByText('action')).toBeInTheDocument();
  });
});
