/**
 * The backend contract: every endpoint the app will call for an action
 * that needs a secret (Cleanverse API key, attestor key, deployer key),
 * something a browser must never hold. Typed here so the frontend can be
 * built against a stable shape before the backend exists. NOT implemented
 * or deployed this session, see docs/BACKEND_CONTRACT.md for the
 * deployment intent (serverless functions, cloud-held secrets, never a
 * server anyone runs locally).
 *
 * Every request carries the borrower/record address explicitly rather
 * than relying on server-side session state, these are single-purpose
 * calls a cloud function can serve statelessly.
 */
import type { Address } from 'viem';

export interface ProvisionRequest {
  address: Address;
  tier: number;
  subTier: number;
}
export interface ProvisionResponse {
  status: 'started';
}

export interface FundRequest {
  address: Address;
  /** Raw 18-decimal amount, as a decimal string, never a JS number (precision). */
  amount: string;
}
export interface FundResponse {
  status: 'started';
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
  error: string | null;
}

/** Route shapes, not URLs, the deployed base URL is app configuration (VITE_BACKEND_URL), not part of the contract. */
export const BACKEND_ROUTES = {
  provision: { method: 'POST', path: '/api/onboarding/provision' },
  fund: { method: 'POST', path: '/api/onboarding/fund' },
  strike: { method: 'POST', path: '/api/positions/:address/strike' },
  advance: { method: 'POST', path: '/api/positions/:address/advance' },
  lastError: { method: 'GET', path: '/api/positions/:address/last-error' },
} as const;
