import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { BrandMark } from '../ui/BrandMark';
import { LiveDot } from '../ui/LiveDot';
import { ConnectButton } from '../../wallet/ConnectButton';

const NAV_LINKS = [
  { to: '/lend', label: 'Lend' },
  { to: '/positions', label: 'Positions' },
  { to: '/pool', label: 'Pool' },
  { to: '/docs', label: 'Docs' },
  { to: '/roadmap', label: 'Roadmap' },
];

/**
 * The frame every page shares: the mark, real-time chain context (the
 * same live block height the ground's breathe is tied to, not a separate
 * fabricated number), and the wallet. What makes the app read as one
 * product rather than a record view with pages attached. Below the
 * breakpoint where the inline nav hides, a toggle opens it as a dropdown,
 * navigation is core chrome, not something a narrow viewport should lose.
 */
export function Header({ blockNumber }: { blockNumber: bigint | null }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <NavLink to="/" className="site-header__brand" aria-label="Revoca home" onClick={() => setMenuOpen(false)}>
          <BrandMark className="site-header__mark" />
          <span className="site-header__wordmark">Revoca</span>
        </NavLink>

        <nav className="site-header__nav" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={({ isActive }) => `site-header__link${isActive ? ' site-header__link--active' : ''}`}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <button
          type="button"
          className="site-header__menu-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className={`site-header__menu-icon${menuOpen ? ' site-header__menu-icon--open' : ''}`} aria-hidden="true" />
        </button>

        <div className="site-header__status">
          <span className="site-header__chain mono">
            <LiveDot className="site-header__chain-dot" />
            Monad testnet
            {blockNumber !== null && <span className="site-header__block">· {blockNumber.toLocaleString('en-US')}</span>}
          </span>
          <ConnectButton />
        </div>
      </div>

      {menuOpen && (
        <nav className="site-header__mobile-nav" aria-label="Primary, mobile">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `site-header__mobile-link${isActive ? ' site-header__mobile-link--active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
