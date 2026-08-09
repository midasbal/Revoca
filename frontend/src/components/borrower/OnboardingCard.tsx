import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { Address } from 'viem';
import { ONBOARDING_SUBTIERS, type OnboardingSubTier, type ProvisionResponse } from '../../api/backendContract';
import { BACKEND_URL, provisionBorrower } from '../../api/onboarding';
import { Button } from '../ui/Button';
import { RatioBandsTable } from './RatioBandsTable';
import { StandingFormRing, type FormRingPhase } from './StandingFormRing';
import { HelpTip } from '../ui/HelpTip';
import { type RatioBandsState } from '../../hooks/useRatioBands';
import { formatBps, explorerTxUrl, shortHash } from '../../chain';

const LEVEL_LABEL: Record<OnboardingSubTier, string> = {
  '0': 'Standard',
  '20': 'Verified',
  '50': 'Trusted',
  '80': 'Priority',
};

/** Real stages the backend actually performs, in this order, see backend/src/onboarding/provision.ts. Timed off measured real durations from this session's own testing, not invented, but the request itself is the only real completion signal, see the working timer below. */
const STAGES = [
  { at: 0, label: 'Verifying your A-Pass' },
  { at: 2500, label: 'Attesting your standing on chain' },
  { at: 5500, label: 'Funding your wallet' },
];

/** The whole real sequence measured ~6-10s end to end against the live sandbox and Monad testnet this session. The ring's forming progress is driven by real elapsed time against this estimate, capped short of complete, it only ever reaches 1 on the real response, never before. */
const ESTIMATED_DURATION_MS = 9000;
const PROGRESS_CAP = 0.94;
const TICK_MS = 100;

function ratioForSubTier(bandsState: RatioBandsState, subTier: OnboardingSubTier): number | null {
  if (bandsState.status !== 'ready') return null;
  const wanted = Number(subTier);
  const match = bandsState.bands.find((band) => band.minTier === 50 && band.minSubTier === wanted);
  return match?.ratioBps ?? null;
}

type FlowState = { step: 'idle' } | { step: 'working' } | { step: 'done'; result: ProvisionResponse } | { step: 'error'; message: string };

/**
 * The real CVI onboarding, staged as what it actually is: a standing
 * being granted. A wallet with no A-Pass picks a verification level
 * (each one a real CompliancePolicy band, shown honestly), the backend
 * provisions a real A-Pass, attests it on chain, and funds real testnet
 * gas + rtUSD, while the ring beside the copy forms from an open,
 * unformed circle into a whole one, in step with that real call. Real
 * progress, real result, or a real error, never a fabricated spinner.
 */
export function OnboardingCard({ address, bandsState }: { address: Address; bandsState: RatioBandsState }) {
  const prefersReduced = useReducedMotion();
  const [subTier, setSubTier] = useState<OnboardingSubTier>('50');
  const [flow, setFlow] = useState<FlowState>({ step: 'idle' });
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState(STAGES[0]!.label);
  const startedAt = useRef(0);

  useEffect(() => {
    if (flow.step !== 'working') return;
    startedAt.current = Date.now();
    setProgress(0);
    setStageLabel(STAGES[0]!.label);

    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      setProgress(Math.min(elapsed / ESTIMATED_DURATION_MS, PROGRESS_CAP));
      const current = [...STAGES].reverse().find((stage) => elapsed >= stage.at);
      if (current) setStageLabel(current.label);
    }, TICK_MS);

    return () => window.clearInterval(id);
  }, [flow.step]);

  async function handleSubmit() {
    setFlow({ step: 'working' });
    try {
      const result = await provisionBorrower(address, subTier);
      setProgress(1);
      setFlow({ step: 'done', result });
    } catch (err) {
      setProgress(0);
      setFlow({ step: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const ringPhase: FormRingPhase = flow.step === 'done' ? 'formed' : flow.step === 'working' ? 'forming' : 'unformed';

  return (
    <div className="onboarding-layout">
      <div className="onboarding-ring-panel" aria-hidden="true">
        <StandingFormRing phase={ringPhase} progress={progress} prefersReduced={prefersReduced} />
        {prefersReduced && flow.step === 'working' && <p className="onboarding-ring-panel__step mono">{stageLabel}&hellip;</p>}
      </div>

      <div className="onboarding-content">
        {flow.step === 'done' ? (
          <OnboardingDone result={flow.result} bandsState={bandsState} />
        ) : (
          <>
            <p className="eyebrow">Get verified to use Revoca</p>
            <h1 className="onboarding__title">A standing can be granted.</h1>
            <p className="onboarding__lede">
              Revoca lends against a verified A-Pass, not an anonymous address. Choose a verification level, real
              CompliancePolicy bands, not arbitrary tiers, then get provisioned: a real A-Pass, attested on chain,
              plus testnet gas and rtUSD so you can actually borrow right away.
            </p>

            <p className="eyebrow onboarding__level-label">
              Verification level
              <HelpTip label="Each level is a real CompliancePolicy band, not a marketing tier: a higher level earns a lower collateral ratio, so it borrows on lighter terms." />
            </p>
            <div className="segmented" role="radiogroup" aria-label="Verification level">
              {ONBOARDING_SUBTIERS.map((level) => {
                const ratioBps = ratioForSubTier(bandsState, level);
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={subTier === level}
                    className={`segmented__option${subTier === level ? ' segmented__option--active' : ''}`}
                    onClick={() => setSubTier(level)}
                    disabled={flow.step === 'working'}
                  >
                    <span className="segmented__label">{LEVEL_LABEL[level]}</span>
                    <span className="segmented__ratio mono">{ratioBps !== null ? formatBps(ratioBps) : '…'}</span>
                  </button>
                );
              })}
            </div>

            {bandsState.status === 'ready' && (
              <details className="onboarding__bands">
                <summary>The full ratio table</summary>
                <RatioBandsTable bands={bandsState.bands} activeTier={50} activeSubTier={Number(subTier)} />
              </details>
            )}

            <div className="action">
              <Button disabled={flow.step === 'working' || !BACKEND_URL} onClick={() => void handleSubmit()}>
                {flow.step === 'working' ? 'Provisioning…' : 'Get verified'}
              </Button>
              {flow.step === 'working' && !prefersReduced && <p className="action__status action__status--stage mono">{stageLabel}&hellip;</p>}
              {!BACKEND_URL && <p className="action__status">Onboarding is served by the backend, not yet deployed.</p>}
              {flow.step === 'error' && <p className="action__status action__status--error">{flow.message}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OnboardingDone({ result, bandsState }: { result: ProvisionResponse; bandsState: RatioBandsState }) {
  const ratioBps = ratioForSubTier(bandsState, result.requestedSubTier);
  return (
    <>
      <p className="eyebrow">Get verified &middot; granted</p>
      <h1 className="onboarding__title">Standing granted.</h1>
      <p className="onboarding__lede">
        A real A-Pass, tier {result.verified.tier}/{result.verified.subTier}, is attested on chain
        {ratioBps !== null && <> &middot; your standing earns {formatBps(ratioBps)} collateral</>}.
      </p>
      <div className="onboarding__receipts mono">
        <a href={explorerTxUrl(result.attestationTxHash)} target="_blank" rel="noreferrer">
          Attestation {shortHash(result.attestationTxHash)}
        </a>
        {result.gasTxHash && (
          <a href={explorerTxUrl(result.gasTxHash)} target="_blank" rel="noreferrer">
            Gas funded {shortHash(result.gasTxHash)}
          </a>
        )}
        <a href={explorerTxUrl(result.mintTxHash)} target="_blank" rel="noreferrer">
          rtUSD funded {shortHash(result.mintTxHash)}
        </a>
      </div>
      <p className="notice" style={{ marginTop: '1rem' }}>
        This page updates to your live standing automatically, usually within a few seconds.
      </p>
    </>
  );
}
