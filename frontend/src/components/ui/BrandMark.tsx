import { motion, useReducedMotion } from 'framer-motion';

/**
 * The actual mark, everywhere it appears in chrome: the real logo
 * (revoca-logo.jpeg), not a vector approximation. Cropped to the ring
 * alone (the header sets its own "Revoca" wordmark in type, the image
 * would otherwise double it) with its slate background removed to alpha
 * and the edge feathered, so it sits directly on the header's own dark
 * ground with no visible box. A very slow breathe signals presence
 * without pretending to be live data.
 */
export function BrandMark({ className }: { className?: string }) {
  const prefersReduced = useReducedMotion();

  return (
    <motion.img
      src="/revoca-mark.png"
      alt="Revoca"
      className={['brand-mark', className].filter(Boolean).join(' ')}
      animate={prefersReduced ? undefined : { opacity: [0.94, 1, 0.94] }}
      transition={{ duration: 4.4, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}
