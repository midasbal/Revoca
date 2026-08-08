/** The small pulsing dot used everywhere the app claims something is live: the header, the status rail, the record's own header strip. One definition, one meaning. */
export function LiveDot({ className }: { className?: string }) {
  return <span className={['live-dot', className].filter(Boolean).join(' ')} aria-hidden="true" />;
}
