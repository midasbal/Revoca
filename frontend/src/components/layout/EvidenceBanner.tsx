import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { DEMO_BORROWER } from '../../deployment';

const DISMISSED_KEY = 'revoca-evidence-banner-dismissed';

/**
 * A persistent, dismissible way to reach the completed revocation and
 * unwind from wherever a visitor lands, not just the landing page's own
 * callout (see LandingPage.tsx). Skipped on "/" itself, that page already
 * carries this same context more prominently, showing both would be
 * redundant clutter rather than help. Dismissal persists in localStorage,
 * once acknowledged it should not keep asking.
 */
export function EvidenceBanner() {
  const location = useLocation();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!dismissed) return;
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Not worth failing over, the banner just reappears on the next visit.
    }
  }, [dismissed]);

  if (dismissed || location.pathname === '/') return null;

  return (
    <div className="evidence-banner" role="note">
      <div className="evidence-banner__inner">
        <p className="evidence-banner__text">
          Revoca&rsquo;s core feature is compliance-reactive unwinding. Cleanverse&rsquo;s freeze endpoint is
          currently returning errors, so a live trigger isn&rsquo;t available here. This is a real completed
          revocation and unwind, verify every step on the explorer.{' '}
          <Link to={`/positions/${DEMO_BORROWER}`} className="evidence-banner__link">
            View the record &rarr;
          </Link>
        </p>
        <button
          type="button"
          className="evidence-banner__close"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          &times;
        </button>
      </div>
    </div>
  );
}
