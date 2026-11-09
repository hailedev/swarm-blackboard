import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Small shared pieces. Status is always an icon and a word: the colour is on the icon (a
// mark), and the text stays in ink so it reads on either surface.

export type Tone = 'neutral' | 'accent' | 'good' | 'warning' | 'serious' | 'critical';

/** Colour for an icon or a dot. Never put these on running text. */
export const TONE_MARK: Record<Tone, string> = {
  neutral: 'text-muted',
  accent: 'text-accent',
  good: 'text-good',
  warning: 'text-warning',
  serious: 'text-serious',
  critical: 'text-critical',
};

/** A tint of the tone over the surface, for the body of a badge. */
export const TONE_WASH: Record<Tone, string> = {
  neutral: 'bg-sunken',
  accent: 'bg-accent/15',
  good: 'bg-good/15',
  warning: 'bg-warning/25',
  serious: 'bg-serious/20',
  critical: 'bg-critical/15',
};

/** Joins class names, skipping the ones a condition turned off. */
export const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ');

export interface BadgeProps {
  tone?: Tone;
  /** A glyph that says the same thing as the colour. */
  icon?: string;
  title?: string;
  children: ReactNode;
}

export const Badge = ({ tone = 'neutral', icon, title, children }: BadgeProps) => (
  <span
    title={title}
    className={cx(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs leading-4 text-ink',
      TONE_WASH[tone],
    )}
  >
    {icon === undefined ? null : (
      <span aria-hidden="true" className={TONE_MARK[tone]}>
        {icon}
      </span>
    )}
    {children}
  </span>
);

export interface HandleChipProps {
  handle: string;
  /** Dimmed when the entry is superseded or dismissed. */
  live?: boolean;
  onSelect?: () => void;
  title?: string;
}

/** An entry's handle (H3, E7…): the name agents, the trace and the board all use. */
export const HandleChip = ({ handle, live = true, onSelect, title }: HandleChipProps) => {
  const className = cx(
    'rounded bg-sunken px-1.5 py-0.5 font-mono text-xs font-semibold text-ink',
    !live && 'line-through opacity-60',
  );
  if (onSelect === undefined) {
    return (
      <span className={className} title={title}>
        {handle}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cx(className, 'cursor-pointer hover:bg-line')}
    >
      {handle}
    </button>
  );
};

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary border-transparent hover:opacity-90',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-sunken',
  danger: 'bg-surface text-ink border-critical hover:bg-critical/10',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-sunken',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = ({ variant = 'secondary', className, type, ...rest }: ButtonProps) => (
  <button
    type={type ?? 'button'}
    className={cx(
      'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium',
      'disabled:cursor-not-allowed disabled:opacity-45',
      BUTTON_VARIANT[variant],
      className,
    )}
    {...rest}
  />
);

export const Panel = ({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section aria-label={title} className={cx('rounded-lg border border-line bg-surface', className)}>
    <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {aside}
    </header>
    {children}
  </section>
);

/** An error the user should read: the server's words, with an icon. */
export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <p
    role="alert"
    className="flex items-start gap-2 rounded border border-critical bg-critical/10 px-3 py-2 text-sm"
  >
    <span aria-hidden="true" className="text-critical">
      ✕
    </span>
    <span>{children}</span>
  </p>
);
