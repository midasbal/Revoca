import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RouterProvider } from 'react-router-dom';
import { wagmiConfig } from './wallet/config';
import { useAutoReconnect } from './wallet/useAutoReconnect';
import { router } from './routes';

const queryClient = new QueryClient();

function AutoReconnect() {
  useAutoReconnect();
  return null;
}

export function AppRoot() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AutoReconnect />
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
