import { ArchitectureDiagram } from '../components/docs/ArchitectureDiagram';
import { CopyableAddress } from '../components/CopyableAddress';
import { DEPLOYMENT } from '../chain';
import { useActiveSection } from '../hooks/useActiveSection';

const REPO_URL = 'https://github.com/midasbal/Revoca';

const SECTIONS = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'hybrid-gate', label: 'The hybrid compliance gate' },
  { id: 'tier-scaled-lending', label: 'Tier-scaled lending' },
  { id: 'graduated-unwind', label: 'The graduated, fair unwind' },
  { id: 'unwind-strategies', label: 'Pluggable unwind strategies' },
  { id: 'audit-trail', label: 'Event-sourced audit trail' },
  { id: 'threat-model', label: 'Threat model' },
  { id: 'deployed-contracts', label: 'Deployed contracts' },
] as const;

const SECTION_IDS = SECTIONS.map((section) => section.id);

/** Every event LendingPool and RevocationGuardian actually emit, real ABI identifiers (see chain.ts), not a paraphrase. */
const AUDIT_EVENTS = [
  'CollateralPosted',
  'Borrow',
  'Repay',
  'CollateralWithdrawn',
  'CollateralAppliedToDebt',
  'Liquidate',
  'PositionFlagged',
  'PositionReinstated',
  'UnwindStarted',
  'UnwindStep',
  'UnwindCompleted',
];

/**
 * The technical reference, in the same voice as the landing narrative but
 * turned toward precision rather than atmosphere. Every claim here is
 * true of the actual deployed code, no invented audits, users, or scale,
 * see docs/ARCHITECTURE.md and docs/THREAT_MODEL.md, this page is the
 * legible version of those, not a separate story. Laid out as a real
 * reference (persistent section nav, scroll-tracked), not a blog column.
 */
export default function DocsPage() {
  const activeId = useActiveSection(SECTION_IDS);

  return (
    <div className="page-wrap docs">
      <div className="registry-head docs-head">
        <p className="eyebrow">Docs</p>
        <h1 className="registry-head__title">How Revoca actually enforces compliance</h1>
        <p className="registry-head__lede">
          A reference, not a pitch. Everything below describes code that exists and runs on Monad testnet today, with
          links to the real contracts and the real repository.
        </p>
        <a className="docs-head__repo" href={REPO_URL} target="_blank" rel="noreferrer">
          View the repository <span aria-hidden="true">&#8599;</span>
        </a>
      </div>

      <div className="docs-layout">
        <nav className="docs-nav" aria-label="Docs sections">
          <ul className="docs-nav__list">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={`docs-nav__link${activeId === section.id ? ' docs-nav__link--active' : ''}`}
                  aria-current={activeId === section.id ? 'true' : undefined}
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="docs-content">
          <section id="architecture" className="docs-section">
            <h2 className="docs-section__title">Architecture</h2>
            <p className="docs-section__body">
              Four real pieces. Cleanverse&rsquo;s UAT sandbox is the source of A-Pass facts. The backend (deployable, never
              run on a user&rsquo;s machine) holds the Cleanverse API key and the attestor&rsquo;s signing key, neither ever
              reaches a browser. Monad testnet holds the contracts that actually decide eligibility and move funds.
              This app reads that chain state directly, live, and writes to it directly through your own wallet, the
              backend is never in that path.
            </p>
            <div className="docs-figure">
              <ArchitectureDiagram />
            </div>
          </section>

          <section id="hybrid-gate" className="docs-section">
            <h2 className="docs-section__title">The hybrid compliance gate</h2>
            <p className="docs-section__body">
              A borrow is gated twice, by two different mechanisms answering two different questions. <em>Is this address
              currently eligible</em> is answered by <code>HybridComplianceGate</code>, an on-chain, synchronous call
              against Cleanverse&rsquo;s own CVI compliance validator, deployed on Monad at the same address on every chain.
              There is no off-chain trust dependency in that specific check: it reverts closed, treated as{' '}
              <mark className="doc-mark">not compliant</mark>, on any failure, never assumed true.
            </p>
            <p className="docs-section__body">
              <em>What tier is this address</em> is a different question the validator cannot answer, its{' '}
              <code>complianceVerify</code> call returns only a pass/fail boolean, never a number. That&rsquo;s{' '}
              <code>ComplianceRegistry</code>&rsquo;s job: a backend attestor reads Cleanverse&rsquo;s <code>query_apass</code> and
              submits a signed EIP-712 attestation of the raw facts (tier, subTier, country, status, expiry), on chain,
              permissionlessly relayed. The registry never stores a verdict, only facts; eligibility is derived live from
              those facts against <code>CompliancePolicy</code>, so tightening policy re-evaluates every existing
              attestation instantly, with no new attestation required.
            </p>
            <p className="docs-section__body">
              The gate mode (validator-backed or attestor-backed) is explicit, owner-set configuration, never inferred
              from a revert at call time. A fallback must never be easier to satisfy than the primary, so there is no
              automatic downgrade path.
            </p>
          </section>

          <section id="tier-scaled-lending" className="docs-section">
            <h2 className="docs-section__title">Tier-scaled lending</h2>
            <p className="docs-section__body">
              Collateral and the lent asset are the same token, so a position&rsquo;s health changes only two ways: interest
              accruing, or the borrower&rsquo;s tier changing. <code>CompliancePolicy</code>&rsquo;s ratio bands are the single source
              of truth for how much collateral a tier requires, from 80% at the highest verified tier to 150% at the
              lowest, read live by the borrower surface and this pool&rsquo;s own <code>currentRatioBps</code>, never a
              hardcoded copy in the UI.
            </p>
          </section>

          <section id="graduated-unwind" className="docs-section">
            <h2 className="docs-section__title">The graduated, fair unwind</h2>
            <p className="docs-section__body">
              When a position&rsquo;s standing fails, <code>RevocationGuardian</code> resolves it through a fixed sequence, not
              instant seizure. A grace period gives a false-positive freeze a real window: <code>reinstate()</code> is
              always callable while <mark className="doc-mark">FLAGGED</mark>, returning the position straight to healthy
              with zero unwind. If grace elapses, self-cure runs first and unconditionally, the borrower&rsquo;s own posted
              collateral pays down their own debt before any third party is ever involved. Only if debt remains after
              self-cure does permissionless liquidation become reachable, and by construction, whenever that happens the
              borrower&rsquo;s collateral has already been drained to zero, so a liquidator receives nothing and still pays the
              full remaining debt. Whatever collateral survives once debt clears is always returned to the borrower, even
              while they remain non-compliant. Settlement, not confiscation.
            </p>
          </section>

          <section id="unwind-strategies" className="docs-section">
            <h2 className="docs-section__title">Pluggable unwind strategies</h2>
            <p className="docs-section__body">
              The unwind&rsquo;s shape (self-cure, then liquidate if needed) is fixed. Its timing is not: <code>IUnwindStrategy</code>{' '}
              swaps in different grace durations without touching the guardian&rsquo;s state machine. Three real strategies
              exist today: <code>GraceAndNotify</code> (the default, grace duration read live from policy),{' '}
              <code>ForcedUnwind</code> (zero grace, unwind eligible in the same block a position is flagged), and{' '}
              <code>ImmediateQuarantine</code> (a short, fixed duration set independently of policy). Every strategy is
              enforced, not just documented: installing one that skips self-cure or disables reinstatement reverts at
              install time.
            </p>
          </section>

          <section id="audit-trail" className="docs-section">
            <h2 className="docs-section__title">Event-sourced audit trail</h2>
            <p className="docs-section__body">
              Every state change (posted, borrowed, repaid, flagged, self-cured, liquidated, resolved) is a real emitted
              event with enough data to reconstruct a position&rsquo;s full history without trusting any cached read. The
              record view&rsquo;s ledger is exactly that reconstruction, live, per address. Balances are read directly off the
              event that reports them (a repay&rsquo;s own remaining-debt field, a self-cure&rsquo;s own remaining-collateral field),
              never derived by subtracting deltas across different event types.
            </p>
            <ul className="docs-chips" aria-label="Events emitted by LendingPool and RevocationGuardian">
              {AUDIT_EVENTS.map((event) => (
                <li key={event} className="docs-chip mono">
                  {event}
                </li>
              ))}
            </ul>
          </section>

          <section id="threat-model" className="docs-section">
            <h2 className="docs-section__title">Threat model: can a freeze be gamed for profit</h2>
            <p className="docs-section__body">
              The concrete worry: could anyone induce a freeze on a borrower specifically to trigger a liquidation they
              profit from. Analyzed structurally, not assumed. <code>isHealthy</code> never reads compliance at all, only
              debt against the tier-derived ratio, so a freeze alone cannot make a healthy position liquidatable.
              Wherever a freeze does lead into the guarded unwind path, self-cure runs first and drains the borrower&rsquo;s
              collateral to zero before a liquidator can ever be involved, so a liquidator who reaches{' '}
              <code>liquidate()</code> afterward seizes exactly zero collateral while still paying the full remaining
              debt, net profit <mark className="doc-mark">strictly negative</mark>. The only positive liquidation profit
              reachable anywhere in the system is the pool&rsquo;s ordinary bonus, present identically with or without any
              freeze.
            </p>
            <div className="docs-callout">
              <p className="docs-callout__label">Proven, not asserted</p>
              <p className="docs-callout__body">
                <code>contracts/test/GriefingBound.t.sol</code>, six properties, five of them fuzzed 5,000 runs each
                across every real collateral-ratio band, all passing.
              </p>
            </div>
          </section>

          <section id="deployed-contracts" className="docs-section docs-section--last">
            <h2 className="docs-section__title">Deployed contracts, Monad testnet</h2>
            <p className="docs-section__body">
              Provisional: this pool will be redeployed again as the contracts keep evolving. These are the addresses
              this app actually reads and writes today.
            </p>
            <div className="docs-contracts">
              <CopyableAddress label="LendingPool" address={DEPLOYMENT.pool} />
              <CopyableAddress label="RevocationGuardian" address={DEPLOYMENT.guardian} />
              <CopyableAddress label="ComplianceRegistry" address={DEPLOYMENT.registry} />
              <CopyableAddress label="HybridComplianceGate" address={DEPLOYMENT.gate} />
              <CopyableAddress label="CompliancePolicy" address={DEPLOYMENT.policy} />
              <CopyableAddress label="Asset (rtUSD)" address={DEPLOYMENT.asset} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
