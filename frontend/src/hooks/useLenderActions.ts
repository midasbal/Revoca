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
  const [errors, setErrors] = useState<Partial<Record<LenderActionKind, string>>>({});

  async function run(kind: LenderActionKind, send: () => Promise<Hex>): Promise<Hex> {
    setPending(kind);
    setErrors((prev) => ({ ...prev, [kind]: undefined }));
    try {
      const hash = await send();
      await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return hash;
    } catch (err) {
      const message = describeTxError(err);
      setErrors((prev) => ({ ...prev, [kind]: message }));
      throw err;
    } finally {
      setPending(null);
    }
  }

  return {
    pending,
    errors,
    /** This kind's own error, or null. What every consumer should actually read, see BorrowerSurface/LenderSurface. */
    errorFor: (kind: LenderActionKind): string | null => errors[kind] ?? null,
    clearError: (kind: LenderActionKind) => setErrors((prev) => ({ ...prev, [kind]: undefined })),
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
