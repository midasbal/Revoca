/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MONAD_RPC_URL?: string;
  /** Base URL of the deployed backend (backend/api/), see docs/ARCHITECTURE.md's frontend/backend split. Unset in local dev, the app reads live chain state directly and honestly disables secret-holding actions. */
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
