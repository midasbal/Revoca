import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { monadTestnet } from 'viem/chains';
import { RPC_URL } from '../chain';

/**
 * A single injected connector (MetaMask or any EIP-1193 wallet), no
 * RainbowKit/Web3Modal, the connect UI is hand-built in ConnectButton.tsx
 * to match the rest of the app. One chain, Monad testnet, this app has
 * nothing to do on any other network.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(RPC_URL),
  },
});
