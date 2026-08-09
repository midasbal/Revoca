import { useState } from 'react';
import { useWriteContract } from 'wagmi';
import type { Hex } from 'viem';
import { ASSET_ABI, DEPLOYMENT, POOL_ABI, publicClient } from '../chain';

export type LenderActionKind = 'approve' | 'deposit' | 'withdraw';

/** Real lender writes, wagmi/viem directly against the deployed LendingPool, gas left to wagmi's own estimation (see useBorrowerActions.ts's header on why a hardcoded limit is unsafe on Monad). */
export function useLenderActions() {
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<LenderActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: LenderActionKind, send: () => Promise<Hex>): Promise<Hex> {
    setPending(kind);
    setError(null);
    try {
      const hash = await send();
      await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return hash;
    } catch (err) {
      setError(describeTxError(err));
      throw err;
    } finally {
      setPending(null);
    }
  }

  return {
    pending,
    error,
    clearError: () => setError(null),
    approve: (amount: bigint) =>
      run('approve', () =>
        writeContractAsync({ address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'approve', args: [DEPLOYMENT.pool, amount] }),
      ),
    deposit: (amount: bigint) => run('deposit', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'deposit', args: [amount] })),
    withdraw: (amount: bigint) => run('withdraw', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'withdraw', args: [amount] })),
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
