import { useState } from 'react';
import type { Address } from 'viem';
import { ONBOARDING_SUBTIERS, type OnboardingSubTier, type ProvisionResponse } from '../../api/backendContract';
import { BACKEND_URL, provisionBorrower } from '../../api/onboarding';
import { Button } from '../ui/Button';
import { RatioBandsTable } from './RatioBandsTable';
import { type RatioBandsState } from '../../hooks/useRatioBands';
import { formatBps, explorerTxUrl, shortHash } from '../../chain';

const LEVEL_LABEL: Record<OnboardingSubTier, string> = {
  '0': 'Standard',
  '20': 'Verified',
  '50': 'Trusted',
  '80': 'Priority',
};

function ratioForSubTier(bandsState: RatioBandsState, subTier: OnboardingSubTier): number | null {
  if (bandsState.status !== 'ready') return null;
  const wanted = Number(subTier);
  const match = bandsState.bands.find((band) => band.minTier === 50 && band.minSubTier === wanted);
  return match?.ratioBps ?? null;
}

type FlowState = { step: 'idle' } | { step: 'working' } | { step: 'done'; result: ProvisionResponse } | { step: 'error'; message: string };

/**
 * The real CVI onboarding, first-class, not a hack. A borrower with no
 * A-Pass picks a verification level (each one a real CompliancePolicy
 * band, shown honestly, not invented), the backend provisions a real
 * A-Pass, attests it on-chain, and funds real testnet gas + rtUSD. Real
 * progress, real result, or a real error, never a fabricated spinner.
 */
export function OnboardingCard({ address, bandsState }: { address: Address; bandsState: RatioBandsState }) {
  const [subTier, setSubTier] = useState<OnboardingSubTier>('50');
  const [flow, setFlow] = useState<FlowState>({ step: 'idle' });

  async function handleSubmit() {
    setFlow({ step: 'working' });
    try {
      const result = await provisionBorrower(address, subTier);
      setFlow({ step: 'done', result });
    } catch (err) {
      setFlow({ step: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (flow.step === 'done') {
    const { result } = flow;
    const ratioBps = ratioForSubTier(bandsState, result.requestedSubTier);
    return (
      <div className="onboarding">
        <p className="eyebrow">Get verified &middot; complete</p>
        <h2 className="onboarding__title">You&rsquo;re verified.</h2>
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
        <p className="notice">The borrower surface below updates as soon as the chain reflects this, a few seconds.</p>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <p className="eyebrow">Get verified to use Revoca</p>
      <h2 className="onboarding__title">This wallet has no standing yet.</h2>
      <p className="onboarding__lede">
        Revoca lends against a verified A-Pass, not an anonymous address. Choose a verification level, real
        CompliancePolicy bands, not arbitrary tiers, then get provisioned: a real A-Pass, attested on chain, plus
        testnet gas and rtUSD so you can actually borrow right away.
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
        {!BACKEND_URL && <p className="action__status">Onboarding is served by the backend, not yet deployed.</p>}
        {flow.step === 'error' && <p className="action__status action__status--error">{flow.message}</p>}
      </div>
    </div>
  );
}
