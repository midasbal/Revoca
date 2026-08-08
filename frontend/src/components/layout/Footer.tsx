import { DEPLOYMENT, explorerAddressUrl } from '../../chain';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__line">Revoca, a live compliance registry for lending on Monad testnet.</p>
        <p className="site-footer__line mono">
          Guardian{' '}
          <a href={explorerAddressUrl(DEPLOYMENT.guardian)} target="_blank" rel="noreferrer">
            {DEPLOYMENT.guardian.slice(0, 10)}…
          </a>
        </p>
      </div>
    </footer>
  );
}
