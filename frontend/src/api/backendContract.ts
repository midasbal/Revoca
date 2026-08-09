/**
 * The backend contract: every endpoint the app calls for an action that
 * needs a secret (Cleanverse API key, attestor key, deployer key),
 * something a browser must never hold. Deployed as small, stateless,
 * serverless functions, see backend/api/ and backend/DEPLOY.md, never a
 * process anyone runs locally (see docs/ARCHITECTURE.md's frontend/
 * backend split).
 *
 * Every request carries the address it acts on explicitly rather than
 * relying on server-side session state, these are single-purpose calls a
 * cloud function can serve statelessly.
 */
import type { Address } from 'viem';

/**
 * The subTier levels this app actually offers during onboarding, each a
 * real CompliancePolicy ratio band, not the full 1-99 range Cleanverse's
 * API allows, see backend/src/onboarding/provision.ts's identical const
 * (kept in sync manually, the two packages have no shared build step).
 */
export const ONBOARDING_SUBTIERS = ['0', '20', '50', '80'] as const;
export type OnboardingSubTier = (typeof ONBOARDING_SUBTIERS)[number];

export interface ProvisionRequest {
  address: Address;
  subTier: OnboardingSubTier;
}

/**
 * Synchronous: the backend does not respond until the whole real sequence
 * (generate_apass, query_apass verify, on-chain attestation, gas + rtUSD
 * funding) has actually completed, no "started, poll elsewhere" stub.
 */
export interface ProvisionResponse {
  address: Address;
  customerId: string;
  cvRecordId: string;
  requestedSubTier: OnboardingSubTier;
  verified: {
    tier: string;
    subTier: number;
    status: 1 | 2 | null;
    expirationTime: number | null;
  };
  attestationTxHash: `0x${string}`;
  fundedGas: boolean;
  gasTxHash: `0x${string}` | null;
  mintTxHash: `0x${string}`;
}

export interface FundRequest {
  address: Address;
  /** Raw 18-decimal amount, as a decimal string, never a JS number (precision). */
  amount?: string;
}
export interface FundResponse {
  address: Address;
  fundedGas: boolean;
  gasTxHash: `0x${string}` | null;
  mintTxHash: `0x${string}`;
  amount: string;
}

export interface StrikeRequest {
  address: Address;
}
export interface StrikeResponse {
  status: 'started';
}

export interface AdvanceUnwindRequest {
  address: Address;
}
export interface AdvanceUnwindResponse {
  status: 'started';
}

export interface ActionErrorResponse {
  error: string;
  step?: string;
}

/** Route shapes, not URLs, the deployed base URL is app configuration (VITE_BACKEND_URL), not part of the contract. */
export const BACKEND_ROUTES = {
  provision: { method: 'POST', path: '/api/onboarding/provision' },
  fund: { method: 'POST', path: '/api/onboarding/fund' },
  strike: { method: 'POST', path: '/api/positions/:address/strike' },
  advance: { method: 'POST', path: '/api/positions/:address/advance' },
  lastError: { method: 'GET', path: '/api/positions/:address/last-error' },
} as const;
