import type { ReactNode } from 'react';

/**
 * Material 3 UI Component Primitives for MedGuard Android Client
 */

export const m3ButtonPrimary =
  'min-h-[48px] min-w-[48px] rounded-full bg-sky-600 px-6 py-3 text-sm font-semibold tracking-wide text-white transition-all hover:bg-sky-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none shadow-md shadow-sky-950/40 flex items-center justify-center gap-2';

export const m3ButtonSecondary =
  'min-h-[48px] min-w-[48px] rounded-full bg-slate-800 border border-slate-700/80 px-6 py-3 text-sm font-semibold tracking-wide text-slate-200 transition-all hover:bg-slate-700 active:scale-95 disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2';

export const m3ButtonDanger =
  'min-h-[48px] min-w-[48px] rounded-full bg-rose-950/60 border border-rose-600/60 px-6 py-3 text-sm font-semibold tracking-wide text-rose-300 transition-all hover:bg-rose-900/80 active:scale-95 disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2';

export const m3InputClass =
  'min-h-[48px] w-full rounded-xl border border-slate-700 bg-slate-900/90 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20';

export function M3Card({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-slate-800/90 bg-slate-900/70 p-5 shadow-sm backdrop-blur-sm transition-all ${
        onClick ? 'cursor-pointer active:scale-[0.99] hover:border-slate-700' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

export type M3BadgeTone = 'safe' | 'locked' | 'capped' | 'neutral' | 'info';

const badgeToneMap: Record<M3BadgeTone, string> = {
  safe: 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30',
  locked: 'bg-rose-950/80 text-rose-300 border border-rose-500/30',
  capped: 'bg-amber-950/80 text-amber-300 border border-amber-500/30',
  neutral: 'bg-slate-800 text-slate-300 border border-slate-700',
  info: 'bg-sky-950/80 text-sky-300 border border-sky-500/30',
};

export function M3Badge({ tone, children }: { tone: M3BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider ${badgeToneMap[tone]}`}>
      {children}
    </span>
  );
}

export function M3TopAppBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800/80 bg-slate-950/90 px-4 py-3.5 backdrop-blur-md">
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400 animate-pulse" />
          <h1 className="text-xl font-bold tracking-tight text-slate-50">{title}</h1>
        </div>
        {subtitle && <p className="text-xs font-medium text-slate-400">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
