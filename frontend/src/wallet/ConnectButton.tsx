import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '../chain';
import { AddressTag } from '../components/ui/AddressTag';
import { Button } from '../components/ui/Button';
import { LiveDot } from '../components/ui/LiveDot';

/**
 * Hand-built connect flow in the app's own visual language, three real
 * states, not a modal: not connected (one button), wrong network (a
 * direct switch prompt, Monad testnet is the only chain this app has
 * anything to say about), connected (the account, copyable, plus a quiet
 * disconnect). No RainbowKit/Web3Modal, this is the entire flow.
 */
export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (!isConnected || !address) {
    const connector = connectors[0];
    return (
      <div className="wallet-action-group">
        <Button
          variant="ghost"
          className="wallet-action"
          disabled={isPending || !connector}
          onClick={() => connector && connect({ connector })}
        >
          {isPending ? 'Connecting…' : 'Connect wallet'}
        </Button>
        {connectError && <p className="wallet-action__error">{connectError.message.split('.')[0]}</p>}
      </div>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <Button variant="strike" className="wallet-action" disabled={switching} onClick={() => switchChain({ chainId: CHAIN_ID })}>
        {switching ? 'Switching…' : 'Switch to Monad testnet'}
      </Button>
    );
  }

  return (
    <div className="wallet-chip">
      <LiveDot className="wallet-chip__dot" />
      <AddressTag address={address} />
      <button type="button" className="wallet-chip__disconnect" onClick={() => disconnect()} aria-label="Disconnect wallet">
        Disconnect
      </button>
    </div>
  );
}
