import { Outlet } from 'react-router-dom';
import { Ground } from '../Ground';
import { Header } from './Header';
import { Footer } from './Footer';
import { useBlockHeight } from '../../hooks/useBlockHeight';

/** The root layout every route renders into: the ground, the header/footer frame, and the page itself in between. */
export function Shell() {
  const { blockNumber } = useBlockHeight();

  return (
    <>
      <Ground pulseKey={blockNumber !== null ? blockNumber.toString() : null} />
      <div className="shell">
        <Header blockNumber={blockNumber} />
        <main className="shell__main">
          <Outlet />
        </main>
        <Footer />
      </div>
    </>
  );
}
