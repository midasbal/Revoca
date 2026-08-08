import type { ButtonHTMLAttributes } from 'react';

type Variant = 'default' | 'strike' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/**
 * The one button primitive the whole app draws from, built on the
 * record's own action button (border-only, fills solid on hover, no
 * gradients, no drop shadow). `strike` reuses the brand's amber for
 * genuinely consequential actions, `ghost` is for quiet secondary
 * actions (nav, wallet chip) that shouldn't compete with the page's
 * real content.
 */
export function Button({ variant = 'default', className, type = 'button', ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...rest} />;
}
