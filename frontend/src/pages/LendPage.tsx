import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '../wallet/ConnectButton';
import { Card } from '../components/ui/Card';
import { OnboardingCard } from '../components/borrower/OnboardingCard';
import { BorrowerSurface } from '../components/borrower/BorrowerSurface';
import { LenderSurface } from '../components/lender/LenderSurface';
import { useBorrowerStanding } from '../hooks/useBorrowerStanding';
import { useLenderPosition } from '../hooks/useLenderPosition';
import { useRatioBands } from '../hooks/useRatioBands';
import { CHAIN_ID } from '../chain';

type Mode = 'borrow' | 'lend';

/**
 * One page, two sides of the same pool: a borrower posts collateral and
 * borrows against a real, verified standing; a lender supplies the
 * liquidity that standing borrows against. Same wallet, same live pool,
 * a toggle rather than a separate page, because that relationship is the
 * point, not two unrelated products.
 */
export default function LendPage() {
  const { address, isConnected, chainId } = useAccount();
  const [mode, setMode] = useState<Mode>('borrow');

  const standing = useBorrowerStanding(mode === 'borrow' && isConnected && chainId === CHAIN_ID ? address : undefined);
  const lender = useLenderPosition(mode === 'lend' && isConnected && chainId === CHAIN_ID ? address : undefined);
  const bandsState = useRatioBands();

  return (
    <div className="page-wrap">
      <div className="mode-toggle" role="tablist" aria-label="Borrow or lend">
        <button type="button" role="tab" aria-selected={mode === 'borrow'} className={`mode-toggle__option${mode === 'borrow' ? ' mode-toggle__option--active' : ''}`} onClick={() => setMode('borrow')}>
          Borrow
        </button>
        <button type="button" role="tab" aria-selected={mode === 'lend'} className={`mode-toggle__option${mode === 'lend' ? ' mode-toggle__option--active' : ''}`} onClick={() => setMode('lend')}>
          Lend
        </button>
      </div>

      {!isConnected || !address ? (
        <Card className="placeholder">
          <p className="eyebrow">{mode === 'borrow' ? 'Borrow' : 'Lend'}</p>
          <h1 className="placeholder__title">
            {mode === 'borrow' ? 'Post collateral, borrow against your standing' : 'Supply liquidity, the pool borrowers draw against'}
          </h1>
          <p className="placeholder__lede">
            {mode === 'borrow'
              ? 'Connect a wallet to see your live A-Pass status and the real collateral ratio your tier earns, read live from the registry.'
              : 'Connect a wallet to see the pool’s live liquidity and utilization, and your own share of it.'}
          </p>
          <div style={{ marginTop: '1.5rem' }}>
            <ConnectButton />
          </div>
        </Card>
      ) : chainId !== CHAIN_ID ? (
        <Card className="placeholder">
          <p className="eyebrow">{mode === 'borrow' ? 'Borrow' : 'Lend'}</p>
          <h1 className="placeholder__title">Wrong network</h1>
          <p className="placeholder__lede">Revoca lends on Monad testnet only. Switch networks to continue.</p>
          <div style={{ marginTop: '1.5rem' }}>
            <ConnectButton />
          </div>
        </Card>
      ) : mode === 'borrow' ? (
        standing.status === 'loading' ? (
          <Card className="placeholder">
            <p className="eyebrow">Borrow</p>
            <p className="notice" style={{ marginTop: '0.75rem' }}>
              Reading your live standing…
            </p>
          </Card>
        ) : standing.status === 'error' ? (
          <Card className="placeholder">
            <p className="eyebrow">Borrow</p>
            <p className="notice" style={{ marginTop: '0.75rem' }}>
              Could not read the chain: {standing.message}
            </p>
          </Card>
        ) : standing.data.hasStanding ? (
          <BorrowerSurface address={address} standing={standing.data} bandsState={bandsState} />
        ) : (
          <OnboardingCard address={address} bandsState={bandsState} />
        )
      ) : lender.status === 'loading' ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <p className="notice" style={{ marginTop: '0.75rem' }}>
            Reading live pool state…
          </p>
        </Card>
      ) : lender.status === 'error' ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <p className="notice" style={{ marginTop: '0.75rem' }}>
            Could not read the chain: {lender.message}
          </p>
        </Card>
      ) : (
        <LenderSurface address={address} lender={lender.data} />
      )}
    </div>
  );
}
