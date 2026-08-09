/**
 * The real data flow, text-diagrammed in docs/ARCHITECTURE.md, drawn
 * here as an actual figure in the app's own palette. Four real pieces:
 * Cleanverse's UAT sandbox, the backend (Cleanverse client + attestor),
 * the Monad testnet contracts, and this frontend, connected exactly as
 * they actually are, not a marketing simplification.
 */
export function ArchitectureDiagram() {
  return (
    <svg viewBox="0 0 960 340" className="arch-diagram" role="img" aria-label="Revoca architecture: Cleanverse UAT sandbox connects to the backend, which relays a signed attestation to the Monad testnet contracts, which the frontend reads and writes to directly.">
      <defs>
        <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--ink-soft)" />
        </marker>
      </defs>

      {/* Cleanverse */}
      <g>
        <rect x="20" y="24" width="220" height="92" rx="4" fill="none" stroke="var(--rule-strong)" />
        <text x="130" y="54" textAnchor="middle" className="arch-diagram__label">Cleanverse UAT sandbox</text>
        <text x="130" y="76" textAnchor="middle" className="arch-diagram__sub">query_apass</text>
        <text x="130" y="94" textAnchor="middle" className="arch-diagram__sub">generate_apass</text>
      </g>

      {/* Validator (separate, on Monad, read directly) */}
      <g>
        <rect x="700" y="24" width="240" height="92" rx="4" fill="none" stroke="var(--rule-strong)" />
        <text x="820" y="54" textAnchor="middle" className="arch-diagram__label">CVI compliance validator</text>
        <text x="820" y="76" textAnchor="middle" className="arch-diagram__sub">Cleanverse&rsquo;s own contract</text>
        <text x="820" y="94" textAnchor="middle" className="arch-diagram__sub">on Monad, read on-chain</text>
      </g>

      {/* Backend */}
      <g>
        <rect x="20" y="150" width="220" height="110" rx="4" fill="none" stroke="var(--rule-strong)" />
        <text x="130" y="180" textAnchor="middle" className="arch-diagram__label">Backend</text>
        <text x="130" y="202" textAnchor="middle" className="arch-diagram__sub">Cleanverse client</text>
        <text x="130" y="220" textAnchor="middle" className="arch-diagram__sub">EIP-712 attestor</text>
        <text x="130" y="238" textAnchor="middle" className="arch-diagram__sub">deployable, no secrets in browser</text>
      </g>

      {/* Monad contracts, amber accent: this is the one place the standing itself lives */}
      <g>
        <rect x="360" y="150" width="240" height="130" rx="4" fill="none" stroke="var(--struck)" strokeOpacity="0.6" />
        <text x="480" y="178" textAnchor="middle" className="arch-diagram__label">Monad testnet</text>
        <text x="480" y="200" textAnchor="middle" className="arch-diagram__sub">HybridComplianceGate</text>
        <text x="480" y="218" textAnchor="middle" className="arch-diagram__sub">ComplianceRegistry</text>
        <text x="480" y="236" textAnchor="middle" className="arch-diagram__sub">LendingPool</text>
        <text x="480" y="254" textAnchor="middle" className="arch-diagram__sub">RevocationGuardian</text>
      </g>

      {/* Frontend */}
      <g>
        <rect x="700" y="150" width="240" height="92" rx="4" fill="none" stroke="var(--rule-strong)" />
        <text x="820" y="180" textAnchor="middle" className="arch-diagram__label">This app</text>
        <text x="820" y="202" textAnchor="middle" className="arch-diagram__sub">reads live via viem</text>
        <text x="820" y="220" textAnchor="middle" className="arch-diagram__sub">writes via wagmi, your wallet</text>
      </g>

      {/* arrows */}
      <line x1="240" y1="70" x2="700" y2="70" stroke="var(--ink-soft)" strokeDasharray="2 4" markerEnd="url(#arch-arrow)" />
      <text x="470" y="62" textAnchor="middle" className="arch-diagram__flow">same address, same identity, different reads</text>

      <line x1="130" y1="116" x2="130" y2="150" stroke="var(--ink-soft)" markerEnd="url(#arch-arrow)" />

      <line x1="240" y1="205" x2="360" y2="205" stroke="var(--struck)" strokeOpacity="0.8" markerEnd="url(#arch-arrow)" />
      <text x="300" y="196" textAnchor="middle" className="arch-diagram__flow">signed attestation</text>

      <line x1="820" y1="116" x2="820" y2="150" stroke="var(--struck)" strokeOpacity="0.8" markerEnd="url(#arch-arrow)" />
      <text x="900" y="136" textAnchor="middle" className="arch-diagram__flow">isCompliant</text>

      <line x1="600" y1="215" x2="700" y2="196" stroke="var(--ink-soft)" markerEnd="url(#arch-arrow)" />
      <text x="655" y="240" textAnchor="middle" className="arch-diagram__flow">tier, position, standing</text>
    </svg>
  );
}
