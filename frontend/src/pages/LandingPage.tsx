import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Hero } from '../components/landing/Hero';
import { NarrativeSection } from '../components/landing/NarrativeSection';
import { NarrativeRingBreak } from '../components/landing/NarrativeRingBreak';
import { ScrollProgress } from '../components/landing/ScrollProgress';
import { Reveal } from '../components/landing/Reveal';
import { Button } from '../components/ui/Button';
import { DEMO_BORROWER } from '../deployment';
import { shortAddress } from '../chain';

/** Cleanverse's on-chain compliance validator on Monad testnet, read live behind Revoca's compliance gate, see docs/ARCHITECTURE.md. */
const VALIDATOR_ADDRESS = '0xaC7e5179C2C7f03f209136886c172eb34F161792';

export default function LandingPage() {
  const narrativeRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <Hero />

      <div id="narrative" className="narrative" ref={narrativeRef}>
        <ScrollProgress target={narrativeRef} />

        <NarrativeSection
          align="left"
          mark="I. The old idea"
          narration={
            <>
              For as long as trust has been written down, it has carried a seal. And a seal could always be broken.
              Revoca keeps that older truth, and puts it on chain: a loan is only as sound as the standing behind it,
              and standing is not a moment but a state, held only as long as it holds true.
            </>
          }
          fact={<>Compliance is verified live and continuously through the loan&rsquo;s life, not once at origination.</>}
        />

        <NarrativeSection
          align="right"
          mark="II. What a standing is"
          narration={
            <>
              A standing here is a verified identity, issued off chain, carried on chain, and revocable by the
              authority that granted it. Revoca does not decide who is worthy. It reads the standing and honors it,
              for exactly as long as it lasts.
            </>
          }
          fact={<>Built on Cleanverse verified identity, the A-Pass, read through the on-chain compliance validator on Monad.</>}
          texture={<>Validator {shortAddress(VALIDATOR_ADDRESS)}</>}
        />

        <NarrativeSection
          align="left"
          mark="III. Standing sets the terms"
          narration={
            <>
              Not every standing carries the same weight. Revoca reads the verified tier of each borrower and lends
              against it accordingly. A stronger standing borrows on lighter terms. The loan follows the one who
              holds it.
            </>
          }
          fact={<>Collateral requirements scale by verified tier, from under-collateralized at the highest tier to fully secured at the lowest.</>}
          texture={
            <>
              Tier 50/80 &rarr; 80% collateral &middot; Tier 0/0 &rarr; 150% collateral
            </>
          }
        />

        <NarrativeSection
          align="right"
          mark="IV. The watch"
          narration={
            <>
              From the moment a loan opens, the standing behind it is watched. Not reviewed by hand, not checked once
              and forgotten. Every position is read against the on-chain registry, continuously, and the registry
              does not look away.
            </>
          }
          fact={<>Positions are re-verified on chain, continuously. If a standing cannot be confirmed, the gate fails closed.</>}
        />

        <section className="narrative-section narrative-section--left narrative-section--break">
          <div className="narrative-section__inner">
            <Reveal className="narrative-section__mark eyebrow">V. The break</Reveal>
            <Reveal className="narrative-ring-wrap" delay={0.1}>
              <NarrativeRingBreak />
            </Reveal>
            <Reveal className="narrative-section__narration" delay={0.2}>
              And when a standing lapses, whether it is frozen, expired, or falls below what the loan requires, the
              loan does not pretend otherwise. The break is recognized, and the unwinding begins.
            </Reveal>
            <Reveal className="narrative-section__fact" delay={0.34}>
              Revocation, expiry, or a tier drop below what the loan requires triggers the reactive unwind.
            </Reveal>
            <Reveal className="narrative-section__texture mono" delay={0.44}>
              event PositionFlagged
            </Reveal>
          </div>
        </section>

        <NarrativeSection
          align="right"
          mark="VI. Settlement, not seizure"
          narration={
            <>
              Nothing is taken in haste. The position is unwound in order. The borrower&rsquo;s own collateral
              answers the debt first. A grace is given, and if the standing returns in time, the loan is made whole
              again. Only what remains truly owed is called in, and whatever is left is returned. This is not
              punishment. It is settlement.
            </>
          }
          fact={
            <>
              A graduated unwind: self-cure from the borrower&rsquo;s own collateral before liquidation, a grace
              period with reinstatement, and residual collateral returned even while non-compliant.
            </>
          }
          texture={<>event UnwindStarted &middot; event UnwindCompleted</>}
        />

        <NarrativeSection
          align="left"
          mark="VII. The record"
          narration={
            <>
              Every step is written where it cannot be quietly revised. The standing, the lapse, the grace, the
              settlement, each recorded on chain, each open to be read back in full, by anyone, at any time.
            </>
          }
          fact={<>An event-sourced, verifiable audit trail, reconstructable in full from on-chain events.</>}
        />

        <section className="narrative-close">
          <Reveal className="narrative-close__inner">
            <p className="narrative-close__title">Standing, honored while it holds. Settled, the moment it breaks.</p>
            <div className="narrative-close__actions">
              <Link to="/app">
                <Button>Enter the app</Button>
              </Link>
              <Link to={`/positions/${DEMO_BORROWER}`}>
                <Button variant="ghost">View a live record</Button>
              </Link>
            </div>
            <p className="narrative-close__footnote mono">Live on Monad testnet.</p>
          </Reveal>
        </section>
      </div>
    </>
  );
}
