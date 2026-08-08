import { motion, useReducedMotion } from 'framer-motion';
import { usePrevious } from '../hooks/usePrevious';

const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/**
 * Wraps a value that changes on real polls (block height, accruing debt)
 * so an update reads as a tick, a brief lift and color settle, rather than
 * a silent snap. Keying the span by value itself means it only remounts
 * (and only then replays the enter transition) when the value actually
 * changes, never on an unrelated re-render. The very first render, there
 * is no prior value to tick from, so it renders statically.
 */
export function TickingValue({ value, className }: { value: string; className?: string }) {
  const prefersReduced = useReducedMotion();
  const prevValue = usePrevious(value);
  const isFirstValue = prevValue === undefined;

  return (
    <motion.span
      className={className}
      key={value}
      initial={!isFirstValue && !prefersReduced ? { opacity: 0.35, y: -3 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE_CONFIDENT }}
    >
      {value}
    </motion.span>
  );
}
