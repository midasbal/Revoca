import { useAccount } from 'wagmi';
import { ConnectButton } from '../wallet/ConnectButton';
import { Card } from '../components/ui/Card';
import { OnboardingCard } from '../components/borrower/OnboardingCard';
import { BorrowerSurface } from '../components/borrower/BorrowerSurface';
import { useBorrowerStanding } from '../hooks/useBorrowerStanding';
import { useRatioBands } from '../hooks/useRatioBands';
import { CHAIN_ID } from '../chain';

/**
 * The real borrower surface: a connected wallet's live standing (A-Pass
 * status, tier, the real ratio that tier earns), and, once that standing
 * exists, the four real actions (post collateral, borrow, repay,
 * withdraw) against the deployed LendingPool. A wallet with no A-Pass
 * gets the real onboarding flow first, not a locked page, see
 * components/borrower/OnboardingCard.tsx.
 */
export default function LendPage() {
  const { address, isConnected, chainId } = useAccount();
  const standing = useBorrowerStanding(isConnected && chainId === CHAIN_ID ? address : undefined);
  const bandsState = useRatioBands();

  return (
    <div className="page-wrap">
      {!isConnected || !address ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <h1 className="placeholder__title">Post collateral, borrow against your standing</h1>
          <p className="placeholder__lede">
            Connect a wallet to see your live A-Pass status and the real collateral ratio your tier earns, read live
            from the registry.
          </p>
          <div style={{ marginTop: '1.5rem' }}>
            <ConnectButton />
          </div>
        </Card>
      ) : chainId !== CHAIN_ID ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <h1 className="placeholder__title">Wrong network</h1>
          <p className="placeholder__lede">Revoca lends on Monad testnet only. Switch networks to continue.</p>
          <div style={{ marginTop: '1.5rem' }}>
            <ConnectButton />
          </div>
        </Card>
      ) : standing.status === 'loading' ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <p className="notice" style={{ marginTop: '0.75rem' }}>
            Reading your live standing…
          </p>
        </Card>
      ) : standing.status === 'error' ? (
        <Card className="placeholder">
          <p className="eyebrow">Lend</p>
          <p className="notice" style={{ marginTop: '0.75rem' }}>
            Could not read the chain: {standing.message}
          </p>
        </Card>
      ) : standing.data.hasStanding ? (
        <BorrowerSurface address={address} standing={standing.data} bandsState={bandsState} />
      ) : (
        <div className="borrower-card">
          <OnboardingCard address={address} bandsState={bandsState} />
        </div>
      )}
    </div>
  );
}
