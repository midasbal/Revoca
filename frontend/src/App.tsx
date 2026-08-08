import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RingMark } from './components/RingMark';
import { Ledger } from './components/Ledger';
import { usePosition } from './hooks/usePosition';
import { useLedger } from './hooks/useLedger';
import { useStrikePhase } from './hooks/useStrikePhase';
import { usePrevious } from './hooks/usePrevious';
import { DEMO_BORROWER } from './deployment';
import { GuardianReason, GuardianState, explorerAddressUrl, formatAmount, formatBps, shortAddress } from './chain';

const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

const DEMO_SERVER_URL = (import.meta.env.VITE_DEMO_SERVER_URL as string | undefined) ?? 'http://localhost:8787';

type ActionKind = 'idle' | 'strike' | 'advance';

function useClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function App() {
  const position = usePosition();
  const { entries } = useLedger();
  const now = useClock();

  // The real sequence behind each action is several sequentially-confirmed
  // Monad testnet transactions, minutes under real congestion, well past
  // what a single HTTP request should stay open for. The server responds
  // as soon as the action is under way (see demoServer.ts), and this app
  // tracks "pending" as "waiting for the guardian's on-chain state to
  // actually move away from what it was when the action was requested",
  // which is what usePosition's own polling already reflects, real
  // progress, not a fabricated spinner.
  const [pending, setPending] = useState<ActionKind>('idle');
  const [pendingSinceState, setPendingSinceState] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (pending === 'idle' || position.status !== 'ready') return;
    if (position.data.guardianState !== pendingSinceState) {
      setPending('idle');
      setPendingSinceState(null);
      setActionError(null);
    }
  }, [pending, pendingSinceState, position]);

  useEffect(() => {
    if (pending === 'idle') return;
    let cancelled = false;
    const id = window.setInterval(() => {
      fetch(`${DEMO_SERVER_URL}/api/last-error`)
        .then((response) => response.json())
        .then((body: { error: string | null }) => {
          if (!cancelled && body.error) {
            setActionError(body.error);
            setPending('idle');
            setPendingSinceState(null);
          }
        })
        .catch(() => {
          // A failed status check is not itself the action failing, the next tick retries.
        });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pending]);

  async function callServer(path: string, kind: ActionKind) {
    if (position.status !== 'ready') return;
    setPending(kind);
    setPendingSinceState(position.data.guardianState);
    setActionError(null);
    try {
      const response = await fetch(`${DEMO_SERVER_URL}${path}`, { method: 'POST' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Request failed with status ${response.status}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setPending('idle');
      setPendingSinceState(null);
    }
  }

  // A RESOLVED guardian record is not, by itself, evidence of a currently
  // struck standing: RESOLVED just means the guardian's last unwind
  // finished, per RevocationGuardian.sol flag() treats HEALTHY and
  // RESOLVED as equally "nothing in progress." What actually determines
  // whether THIS record is struck right now is whether the borrower is
  // still non-compliant, the guardian state alone can't tell that apart
  // from "resolved, and since re-attested compliant, ready to be flagged
  // again from a clean slate."
  const struck =
    position.status === 'ready' &&
    (position.data.guardianState === GuardianState.FLAGGED ||
      position.data.guardianState === GuardianState.UNWINDING ||
      (position.data.guardianState === GuardianState.RESOLVED && !position.data.compliant));

  const readyToStrike =
    position.status === 'ready' &&
    (position.data.guardianState === GuardianState.HEALTHY ||
      (position.data.guardianState === GuardianState.RESOLVED && position.data.compliant));

  const { phase, prefersReduced, completeStrike } = useStrikePhase(struck, position.status === 'ready');
  const prevPhase = usePrevious(phase);
  const wordLive = phase === 'striking' || prevPhase === 'striking';

  const graceRemaining = useMemo(() => {
    if (position.status !== 'ready') return null;
    if (position.data.guardianState !== GuardianState.FLAGGED) return null;
    return Number(position.data.graceEndsAt) - now;
  }, [position, now]);

  return (
    <div className="page">
      <main className="record">
        <div className="record__header">
          <span className="eyebrow">Revoca &middot; Compliance Registry</span>
          <span className="eyebrow record__live">
            <span className="record__live-dot" aria-hidden="true" />
            Live, Monad testnet
          </span>
        </div>

        <div className="seal-band">
          <div className="seal-band__ring">
            <RingMark phase={position.status === 'ready' ? phase : 'valid'} prefersReduced={prefersReduced} onStrikeComplete={completeStrike} />
          </div>

          <div className="field seal-band__standing">
            <p className="eyebrow field__label">Standing</p>
            {position.status === 'ready' ? (
              <>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={phase === 'struck' ? 'struck' : 'valid'}
                    className={phase === 'struck' ? 'field__value field__value--struck' : 'field__value field__value--valid'}
                    initial={phase === 'struck' && wordLive && !prefersReduced ? { opacity: 0, y: 4 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: EASE_CONFIDENT, delay: phase === 'struck' && wordLive ? 0.28 : 0 }}
                  >
                    {phase === 'struck' ? 'STRUCK' : 'VALID'}
                  </motion.p>
                </AnimatePresence>
                <p className="field__meta">
                  {struck ? (
                    <>
                      Reason: <span className="mono">{GuardianReason[position.data.guardianReason] ?? 'UNKNOWN'}</span>
                      {position.data.guardianState === GuardianState.RESOLVED && ' · Unwind resolved'}
                    </>
                  ) : (
                    <>Attested compliant and fresh, no unwind in progress</>
                  )}
                </p>
              </>
            ) : (
              <p className="field__value field__value--loading">&hellip;</p>
            )}
          </div>
        </div>

        <p className="record__number">
          Record No.{' '}
          <strong className="mono">
            <a href={explorerAddressUrl(DEMO_BORROWER)} target="_blank" rel="noreferrer">
              {shortAddress(DEMO_BORROWER)}
            </a>
          </strong>
        </p>

        {position.status === 'loading' && <p className="notice">Reading live position&hellip;</p>}
        {position.status === 'error' && <p className="notice">Could not read the chain: {position.message}</p>}

        {position.status === 'ready' && (
          <>
            <div className="ruled">
              <span className="eyebrow ruled__label">
                Attested tier {position.data.tier} / subtier {position.data.subTier}
              </span>
            </div>

            <div className="stats">
              <div className="stat">
                <p className="eyebrow stat__label">Collateral ratio</p>
                <p className="stat__value">{formatBps(position.data.ratioBps)}</p>
              </div>
              <div className="stat">
                <p className="eyebrow stat__label">Debt</p>
                <p className="stat__value">
                  {formatAmount(position.data.debt)}
                  <span className="stat__unit">rtUSD</span>
                </p>
              </div>
              <div className="stat">
                <p className="eyebrow stat__label">Collateral</p>
                <p className="stat__value">
                  {formatAmount(position.data.collateral)}
                  <span className="stat__unit">rtUSD</span>
                </p>
              </div>
            </div>
          </>
        )}

        <div className="ruled">
          <span className="eyebrow ruled__label">Ledger</span>
        </div>
        <Ledger entries={entries} nowSeconds={now} />

        <div className="action">
          {readyToStrike && (
            <button
              type="button"
              className="action__button action__button--strike"
              disabled={pending !== 'idle'}
              onClick={() => void callServer('/api/strike', 'strike')}
            >
              {pending === 'strike' ? 'Striking record…' : 'Strike this record'}
            </button>
          )}

          {position.status === 'ready' && position.data.guardianState === GuardianState.FLAGGED && (
            <button
              type="button"
              className="action__button"
              disabled={pending !== 'idle' || (graceRemaining !== null && graceRemaining > 0)}
              onClick={() => void callServer('/api/advance', 'advance')}
            >
              {pending === 'advance' ? 'Advancing the unwind…' : 'Advance the unwind'}
            </button>
          )}

          {position.status === 'ready' && position.data.guardianState === GuardianState.UNWINDING && (
            <button
              type="button"
              className="action__button"
              disabled={pending !== 'idle'}
              onClick={() => void callServer('/api/advance', 'advance')}
            >
              {pending === 'advance' ? 'Advancing the unwind…' : 'Complete the unwind'}
            </button>
          )}

          {position.status === 'ready' && position.data.guardianState === GuardianState.RESOLVED && !readyToStrike && (
            <p className="action__status">Record resolved, still non-compliant, this position is closed.</p>
          )}

          {graceRemaining !== null && graceRemaining > 0 && (
            <p className="action__status">
              Grace ends in <span className="action__countdown mono">{graceRemaining}s</span>, the record may still be
              reinstated
            </p>
          )}

          {actionError && <p className="action__status action__status--error">{actionError}</p>}
        </div>
      </main>
    </div>
  );
}
