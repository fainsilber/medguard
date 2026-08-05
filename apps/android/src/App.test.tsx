import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { App } from './App.js';

describe('Android Client App', () => {
  it('renders top app bar with FCM status and caregiver name', () => {
    render(<App />);
    expect(screen.getByText('MedGuard Android')).toBeInTheDocument();
    expect(screen.getByText('FCM Active')).toBeInTheDocument();
  });

  it('renders bottom navigation tabs', () => {
    render(<App />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('PRN')).toBeInTheDocument();
    expect(screen.getByText('Medicines')).toBeInTheDocument();
    expect(screen.getByText('Inventory')).toBeInTheDocument();
    expect(screen.getByText('Shabbat')).toBeInTheDocument();
    expect(screen.getByText('Device')).toBeInTheDocument();
  });
});
