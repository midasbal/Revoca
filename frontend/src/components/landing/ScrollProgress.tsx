import { motion, useScroll, useSpring } from 'framer-motion';
import type { RefObject } from 'react';

/** A thin, quiet readout of how far through the narrative the reader has come, not decoration, an honest progress signal for a genuinely long page. */
export function ScrollProgress({ target }: { target: RefObject<HTMLElement | null> }) {
  const { scrollYProgress } = useScroll({ target, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.3 });

  return (
    <div className="scroll-progress" aria-hidden="true">
      <motion.div className="scroll-progress__bar" style={{ scaleX: progress }} />
    </div>
  );
}
