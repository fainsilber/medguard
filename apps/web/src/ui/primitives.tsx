import type { ReactNode } from 'react';

/**
 * Shared look for every screen built this sprint. Dark-first and large tap targets are defaults
 * from Sprint 0's index.css, not retrofitted — this app gets used half-asleep, in the dark.
 */

export const buttonClass =
  'rounded-md bg-slate-800 px-3 py-2 text-sm font-medium hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';

export const primaryButtonClass =
  'rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50';

/** For the one deliberately hard-to-misuse action in the app: a safety override. */
export const dangerButtonClass =
  'rounded-md border border-locked bg-locked/10 px-3 py-2 text-sm font-medium text-locked hover:bg-locked/20 disabled:cursor-not-allowed disabled:opacity-50';

export const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm';

export const labelClass = 'flex flex-col gap-1 text-sm';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-3 rounded-lg border border-slate-800 p-4 ${className}`}>
      {children}
    </section>
  );
}

export type BadgeTone = 'safe' | 'locked' | 'capped' | 'neutral';

const badgeToneClass: Record<BadgeTone, string> = {
  safe: 'bg-safe/15 text-safe',
  locked: 'bg-locked/15 text-locked',
  capped: 'bg-capped/20 text-slate-200',
  neutral: 'bg-slate-800 text-slate-300',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badgeToneClass[tone]}`}>
      {children}
    </span>
  );
}
