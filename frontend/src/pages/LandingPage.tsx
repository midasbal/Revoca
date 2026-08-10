import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Hero } from '../components/landing/Hero';
import { NarrativeSection } from '../components/landing/NarrativeSection';
import { ScrollProgress } from '../components/landing/ScrollProgress';
import { Reveal } from '../components/landing/Reveal';
import { Keyword } from '../components/landing/Keyword';
import { Button } from '../components/ui/Button';
import { shortAddress } from '../chain';
import { DEMO_BORROWER } from '../deployment';

/** Cleanverse's on-chain compliance validator on Monad testnet, read live behind Revoca's compliance gate, see docs/ARCHITECTURE.md. */
const VALIDATOR_ADDRESS = '0xaC7e5179C2C7f03f209136886c172eb34F161792';

export default function LandingPage() {
  const narrativeRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <Hero />

      <div className="narrative" style={{ paddingTop: 'var(--space-6)' }}>
        <Link to={`/positions/${DEMO_BORROWER}`} className="evidence-callout">
          <p className="evidence-callout__label">A real revocation, unwound on chain</p>
          <p className="evidence-callout__body">
            See a struck standing and its full unwind ledger, every step a real Monad testnet transaction.{' '}
            <span className="evidence-callout__arrow">View the record &rarr;</span>
          </p>
        </Link>
      </div>

      <div id="narrative" className="narrative" ref={narrativeRef}>
        <ScrollProgress target={narrativeRef} />

        <NarrativeSection
          align="left"
          mark="I. The old idea"
          narration={
            <>
              For as long as trust has been written down, it has carried a seal. And a seal could always be{' '}
              <Keyword>broken</Keyword>. Revoca keeps that older truth, and puts it on chain: a loan is only as
              sound as the <Keyword>standing</Keyword> behind it, and standing is not a moment but a state, held
              only as long as it holds true.
            </>
          }
          fact={<>Compliance is verified live and continuously through the loan&rsquo;s life, not once at origination.</>}
        />

        <NarrativeSection
          align="right"
          mark="II. What a standing is"
          narration={
            <>
              A standing here is a verified identity, issued off chain, carried on chain, and <Keyword>revocable</Keyword>{' '}
              by the authority that granted it. Revoca does not decide who is worthy. It reads the standing and{' '}
              <Keyword>honors</Keyword> it, for exactly as long as it lasts.
            </>
          }
          fact={<>Built on Cleanverse verified identity, the A-Pass, read through the on-chain compliance validator on Monad.</>}
        />

        <NarrativeSection
          align="left"
          mark="III. Standing sets the terms"
          narration={
            <>
              Not every <Keyword>standing</Keyword> carries the same weight. Revoca reads the verified tier of each
              borrower and lends against it accordingly. A stronger standing borrows on lighter terms. The loan
              follows the one who holds it.
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
              From the moment a loan opens, the <Keyword>standing</Keyword> behind it is watched. Not reviewed by
              hand, not checked once and forgotten. Every position is read against the on-chain registry,{' '}
              <Keyword tier="secondary">continuously</Keyword>, and the registry does not look away.
            </>
          }
          fact={<>Positions are re-verified on chain, continuously. If a standing cannot be confirmed, the gate fails closed.</>}
          texture={<>Validator {shortAddress(VALIDATOR_ADDRESS)}</>}
        />

        <NarrativeSection
          align="left"
          mark="V. The break"
          narration={
            <>
              And when a standing lapses, whether it is <Keyword>frozen</Keyword>, <Keyword>expired</Keyword>, or
              falls below what the loan requires, the loan does not pretend otherwise. The{' '}
              <Keyword>break</Keyword> is recognized, and the unwinding begins.
            </>
          }
          fact={<>Revocation, expiry, or a tier drop below what the loan requires triggers the reactive unwind.</>}
          texture={<>event PositionFlagged</>}
        />

        <NarrativeSection
          align="right"
          mark="VI. Settlement, not seizure"
          narration={
            <>
              Nothing is taken in haste. The position is unwound in order. The borrower&rsquo;s own collateral
              answers the debt first. A <Keyword>grace</Keyword> is given, and if the standing returns in time, the
              loan is made whole again. Only what remains truly owed is called in, and whatever is left is
              returned. This is not punishment. It is <Keyword>settlement</Keyword>.
            </>
          }
          fact={
            <>
              A graduated unwind: self-cure from the borrower&rsquo;s own collateral before liquidation, a grace
              period with reinstatement, and residual collateral returned even while non-compliant.
            </>
          }
          texture={<>UnwindStarted &rarr; grace &rarr; self-cure &rarr; liquidate &rarr; UnwindCompleted</>}
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
          texture={<>PositionFlagged &middot; UnwindStarted &middot; UnwindCompleted</>}
        />

        <section className="narrative-close">
          <Reveal className="narrative-close__inner">
            <p className="narrative-close__title">
              Standing, <Keyword>honored</Keyword> while it holds. Settled, the moment it <Keyword>breaks</Keyword>.
            </p>
            <div className="narrative-close__actions">
              <Link to="/lend">
                <Button>Take up a standing</Button>
              </Link>
              <Link to={`/positions/${DEMO_BORROWER}`}>
                <Button variant="ghost">See a real revocation and unwind &rarr;</Button>
              </Link>
            </div>
            <p className="narrative-close__footnote mono">Live on Monad testnet.</p>
          </Reveal>
        </section>
      </div>
    </>
  );
}
