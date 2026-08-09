import { useState } from 'react';
import { useWriteContract } from 'wagmi';
import type { Hex } from 'viem';
import { ASSET_ABI, DEPLOYMENT, POOL_ABI, publicClient } from '../chain';

export type ActionKind = 'approve' | 'post' | 'borrow' | 'repay' | 'withdraw';

/**
 * Every borrower write, real transactions via wagmi/viem against the
 * deployed LendingPool and asset, no backend involved (these actions
 * hold no secret). Gas is left to wagmi's own estimation, never a
 * hardcoded limit: a hardcoded 300k gas cap silently under-estimated
 * `borrow()`'s real cost during this session's own testing (real gasUsed
 * ran near 950k on Monad testnet), a hardcoded ceiling is a real way to
 * make a genuinely valid action fail. Errors are scoped per action kind,
 * not a single shared slot: rejecting one action must never surface
 * under an unrelated one, each button owns only its own failure.
 */
export function useBorrowerActions() {
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<ActionKind | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ActionKind, string>>>({});

  async function run(kind: ActionKind, send: () => Promise<Hex>): Promise<Hex> {
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
    /** This kind's own error, or null. What every consumer should actually read, see BorrowerSurface. */
    errorFor: (kind: ActionKind): string | null => errors[kind] ?? null,
    clearError: (kind: ActionKind) => setErrors((prev) => ({ ...prev, [kind]: undefined })),
    approve: (amount: bigint) =>
      run('approve', () =>
        writeContractAsync({ address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'approve', args: [DEPLOYMENT.pool, amount] }),
      ),
    postCollateral: (amount: bigint) =>
      run('post', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'postCollateral', args: [amount] })),
    borrow: (amount: bigint) =>
      run('borrow', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'borrow', args: [amount] })),
    repay: (amount: bigint) =>
      run('repay', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'repay', args: [amount] })),
    withdrawCollateral: (amount: bigint) =>
      run('withdraw', () => writeContractAsync({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'withdrawCollateral', args: [amount] })),
  };
}

/** Strips a wagmi/viem contract error down to the one useful line, our voice, not a stack trace. */
export function describeTxError(err: unknown): string {
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
