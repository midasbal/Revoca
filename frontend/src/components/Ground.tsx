import { motion, useReducedMotion } from 'framer-motion';

/**
 * The app's fixed environment, behind every page. Replaces an earlier
 * ruled/grid texture (eye-straining at any real reading distance) with a
 * fine, still grain, the kind of quiet material quality a real printed
 * register has, plus a soft vignette that gives the page depth without
 * a single visible line. A slow ambient breathe ties it to `pulseKey`
 * (expected to change on a real block-height poll), the app is watching
 * the chain even where there's no record on screen, felt, not noticed.
 */
export function Ground({ pulseKey }: { pulseKey: string | number | null }) {
  const prefersReduced = useReducedMotion();

  return (
    <div className="ground" aria-hidden="true">
      <div className="ground__grain" />
      <div className="ground__vignette" />
      {!prefersReduced && pulseKey !== null && (
        <motion.div
          key={pulseKey}
          className="ground__breathe"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.07, 0] }}
          transition={{ duration: 2.4, ease: 'easeInOut' }}
        />
      )}
    </div>
  );
}
