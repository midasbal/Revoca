import type { HTMLAttributes } from 'react';

/** The one raised-surface primitive, the record card's own treatment, reused everywhere a page needs a lifted surface. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', className].filter(Boolean).join(' ')} {...rest} />;
}
