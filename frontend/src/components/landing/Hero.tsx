import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';

const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/**
 * The hero is the photograph: a real cracked ceramic ring on slate, one
 * amber segment broken free, the thesis as an object rather than an
 * illustration of one. The negative space it leaves, lower right, is
 * where the words go, in relation to the break, never over it. A slow
 * parallax (the image drifts slower than scroll) is the only ambient
 * motion here besides the load-in settle, reduced motion holds it still.
 */
export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const prefersReduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const imageY = useTransform(scrollYProgress, [0, 1], ['0%', '14%']);

  return (
    <section className="hero-full" ref={ref}>
      <div className="hero-full__frame">
        <motion.div className="hero-full__image" style={{ y: prefersReduced ? 0 : imageY, scale: 1.2 }} />
        <div className="hero-full__grain" aria-hidden="true" />
        <div className="hero-full__scrim" aria-hidden="true" />
      </div>

      <div className="hero-full__content">
        <motion.h1
          className="hero-full__title"
          initial={prefersReduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.35, ease: EASE_CONFIDENT }}
        >
          A standing can be granted.
          <br />A standing can be broken.
        </motion.h1>
        <motion.p
          className="hero-full__lede mono"
          initial={prefersReduced ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.55, ease: EASE_CONFIDENT }}
        >
          Revoca is lending that watches the standing behind every loan, and answers the moment it breaks. Live on
          Monad testnet.
        </motion.p>
      </div>

      <motion.a
        href="#narrative"
        className="hero-full__scroll-cue"
        aria-label="Read on"
        initial={prefersReduced ? false : { opacity: 0 }}
        animate={prefersReduced ? { opacity: 0.7 } : { opacity: [0.4, 0.85, 0.4], y: [0, 5, 0] }}
        transition={prefersReduced ? { duration: 0.9, delay: 0.9 } : { duration: 2.6, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      >
        <span className="hero-full__scroll-line" aria-hidden="true" />
        <span className="hero-full__scroll-label">Read on</span>
      </motion.a>
    </section>
  );
}
