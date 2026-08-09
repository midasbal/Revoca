import { Reveal } from '../components/landing/Reveal';

interface RoadmapItem {
  title: string;
  tag: string;
  why: string;
}

interface RoadmapPhase {
  id: string;
  label: string;
  intro: string;
  items: RoadmapItem[];
}

/**
 * Grounded in the real codebase, the real Cleanverse integration, and the
 * honestly-stated limitations in README.md/docs, not generic buzzwords.
 * Kept in sync with ROADMAP.md at the repo root, this page is the designed
 * version of that file, not a separate story. No item claims something
 * already built that isn't.
 */
const PHASES: RoadmapPhase[] = [
  {
    id: 'near-term',
    label: 'Near-term',
    intro: 'Scoped, buildable directly against the code as it stands today.',
    items: [
      {
        title: 'Partial, proportional liquidation',
        tag: 'Contracts',
        why: "LendingPool.liquidate() requires repaying a position's full debt to unwind it at all today; a partial-repay path that restores health without full seizure is a direct fix to that documented limitation, not a new idea grafted on.",
      },
      {
        title: 'Compliance policies that use the facts already attested',
        tag: 'Compliance',
        why: "ComplianceRegistry already stores and can check a borrower's country and expiry, the deployed pool's validator-gated mode just doesn't use them yet; wiring those already-attested facts into live eligibility deepens the compliance-reactive thesis instead of stopping at pass or fail.",
      },
    ],
  },
  {
    id: 'next',
    label: 'Next',
    intro: 'Larger in scope, still bounded to testnet.',
    items: [
      {
        title: 'Distinct collateral and borrow assets, real markets',
        tag: 'Contracts',
        why: 'Collateral and the lent asset are the same token today, an explicit simplification; separating them, and supporting more than one market, is the natural next step toward pricing genuinely different assets against a verified standing.',
      },
      {
        title: "A keeper that runs, not one you invoke",
        tag: 'Infra',
        why: "The keeper that drives the unwind is proven correct in dry-run and local rehearsal, but it isn't yet a standing, monitored service; production-grade reactivity needs it running continuously, not by hand.",
      },
    ],
  },
  {
    id: 'longer-term',
    label: 'Longer-term',
    intro: 'What production, not just a working demo, actually requires.',
    items: [
      {
        title: 'More than one attestor',
        tag: 'Trust',
        why: 'ComplianceRegistry already supports multiple simultaneous authorized signers, but only one attestor process actually runs today; moving to a real multi-attestor or threshold model shrinks the single-key trust assumption the threat model names directly, not a hypothetical risk.',
      },
      {
        title: 'A hardened, audited mainnet deployment',
        tag: 'Production',
        why: 'Every deployment so far, including this one, is explicit test infrastructure; real value needs a non-provisional deploy and an independent security audit first, the literal, unglamorous distance between testnet-proven and production-ready.',
      },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <div className="page-wrap">
      <div className="registry-head">
        <p className="eyebrow">Roadmap</p>
        <h1 className="registry-head__title">Testnet-proven, not yet production.</h1>
        <p className="registry-head__lede">
          The core loop, tier-scaled lending, the compliance gate, the graduated unwind, is real and proven end to
          end on live Monad testnet transactions. This is what actually stands between that and production,
          grounded in the code as it exists today, not aspiration.
        </p>
      </div>

      {PHASES.map((phase) => (
        <Reveal key={phase.id} className="roadmap-phase" y={16}>
          <section aria-labelledby={`phase-${phase.id}`}>
            <div className="roadmap-phase__head">
              <p id={`phase-${phase.id}`} className="eyebrow roadmap-phase__label">
                {phase.label}
              </p>
              <p className="roadmap-phase__intro">{phase.intro}</p>
            </div>

            <div className="roadmap-phase__grid">
              {phase.items.map((item) => (
                <article key={item.title} className="roadmap-item">
                  <div className="roadmap-item__head">
                    <h2 className="roadmap-item__title">{item.title}</h2>
                    <span className="roadmap-item__tag mono">{item.tag}</span>
                  </div>
                  <p className="roadmap-item__why">{item.why}</p>
                </article>
              ))}
            </div>
          </section>
        </Reveal>
      ))}

      <Reveal className="roadmap-scope" y={16}>
        <p className="eyebrow roadmap-scope__label">Deliberately not here</p>
        <p className="roadmap-scope__body">
          Cross-pool revocation propagation, a native token, ZK identity, on-chain governance. Each would scatter
          the compliance-reactive thesis rather than deepen it, worth revisiting only once everything above is
          real.
        </p>
      </Reveal>
    </div>
  );
}
