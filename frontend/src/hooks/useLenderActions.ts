import { useState } from 'react';
import { useWriteContract } from 'wagmi';
import type { Address, Hex } from 'viem';
import { ASSET_ABI, DEPLOYMENT, POOL_ABI, publicClient } from '../chain';

export type LenderActionKind = 'approve' | 'deposit' | 'withdraw' | 'mint';

/**
 * Real lender writes, wagmi/viem directly against the deployed LendingPool,
 * gas left to wagmi's own estimation (see useBorrowerActions.ts's header on
 * why a hardcoded limit is unsafe on Monad). Errors are scoped per action
 * kind, not a single shared slot: rejecting the mint must never surface
 * under deposit or withdraw, each button owns only its own failure.
 */
export function useLenderActions() {
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<LenderActionKind | null>(null);
  const [phase, setPhase] = useState<'signing' | 'confirming' | null>(null);
  const [errors, setErrors] = useState<Partial<Record<LenderActionKind, string>>>({});
  const [successes, setSuccesses] = useState<Partial<Record<LenderActionKind, Hex>>>({});

  async function run(kind: LenderActionKind, send: () => Promise<Hex>): Promise<Hex> {
    setPending(kind);
    setPhase('signing');
    setErrors((prev) => ({ ...prev, [kind]: undefined }));
    setSuccesses((prev) => ({ ...prev, [kind]: undefined }));
    try {
      const hash = await send();
      setPhase('confirming');
      await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      setSuccesses((prev) => ({ ...prev, [kind]: hash }));
      return hash;
    } catch (err) {
      const message = describeTxError(err);
      setErrors((prev) => ({ ...prev, [kind]: message }));
      throw err;
    } finally {
      setPending(null);
      setPhase(null);
    }
  }

  return {
    pending,
    /** 'signing' while the wallet prompt is up, 'confirming' once broadcast, waiting for the receipt. Null when idle. */
    phase,
    errors,
    /** This kind's own error, or null. What every consumer should actually read, see BorrowerSurface/LenderSurface. */
    errorFor: (kind: LenderActionKind): string | null => errors[kind] ?? null,
    clearError: (kind: LenderActionKind) => setErrors((prev) => ({ ...prev, [kind]: undefined })),
    /** This kind's own last-confirmed tx hash, or null. Cleared the moment a new action of the same kind starts. */
    successFor: (kind: LenderActionKind): Hex | null => successes[kind] ?? null,
    clearSuccess: (kind: LenderActionKind) => setSuccesses((prev) => ({ ...prev, [kind]: undefined })),
    approve: (amount: bigint) =>
      run('approve', () =>
        writeContractAsync({ address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'approve', args: [DEPLOYMENT.pool, amount] }),
      ),
    deposit: (amount: bigint) => run('deposit', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'deposit', args: [amount] })),
    withdraw: (amount: bigint) => run('withdraw', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'withdraw', args: [amount] })),
    // rtUSD's own mint, unrestricted by design (see chain.ts's ASSET_ABI), a real on-chain testnet faucet, no backend involved.
    mintTestAsset: (to: Address, amount: bigint) =>
      run('mint', () => writeContractAsync({ address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'mint', args: [to, amount] })),
  };
}

function describeTxError(err: unknown): string {
  if (err && typeof err === 'object') {
    if ('shortMessage' in err && typeof (err as { shortMessage?: unknown }).shortMessage === 'string') {
      return (err as { shortMessage: string }).shortMessage;
    }
    if ('message' in err && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message.split('\n')[0]!;
    }
  }
  return String(err);
}
