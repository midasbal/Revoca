/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MONAD_RPC_URL?: string;
  readonly VITE_DEMO_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
