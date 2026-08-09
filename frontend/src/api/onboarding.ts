import type { Address } from 'viem';
import type { ActionErrorResponse, OnboardingSubTier, ProvisionResponse } from './backendContract';

/** Set once the backend is actually deployed, see docs/ARCHITECTURE.md's frontend/backend split. Unset, onboarding is honestly disabled rather than pointed at a local process nobody should run. */
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string | undefined;

export async function provisionBorrower(address: Address, subTier: OnboardingSubTier): Promise<ProvisionResponse> {
  if (!BACKEND_URL) {
    throw new Error('Onboarding is served by the backend, not yet deployed.');
  }
  const response = await fetch(`${BACKEND_URL}/api/onboarding/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, subTier }),
  });
  const body = (await response.json()) as ProvisionResponse | ActionErrorResponse;
  if (!response.ok || 'error' in body) {
    throw new Error('error' in body ? body.error : `Request failed with status ${response.status}`);
  }
  return body;
}
