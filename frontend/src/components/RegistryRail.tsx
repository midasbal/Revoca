import { CopyableAddress } from './CopyableAddress';
import { DEPLOYMENT } from '../chain';

/**
 * The console's right rail: what this record is actually being checked
 * against, the registry and pool contracts, not decoration. Addresses are
 * public deployment data (see deployment.ts), copy-on-click since this
 * rail's job is reference, not navigation, the record number above still
 * links straight to the explorer.
 */
export function RegistryRail() {
  return (
    <aside className="rail rail--registry" aria-label="Registry contracts">
      <svg className="rail__watermark" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="86" fill="none" stroke="currentColor" strokeWidth="10" />
      </svg>

      <div className="rail__block">
        <p className="eyebrow rail__label">Compliance registry</p>
        <p className="rail__prose">Every standing on this record is read live against the on-chain registry below, no cached or assumed state.</p>
      </div>

      <div className="rail__block rail__block--addresses">
        <p className="eyebrow rail__label">Contracts</p>
        <CopyableAddress label="Registry" address={DEPLOYMENT.registry} />
        <CopyableAddress label="Guardian" address={DEPLOYMENT.guardian} />
        <CopyableAddress label="Pool" address={DEPLOYMENT.pool} />
      </div>
    </aside>
  );
}
