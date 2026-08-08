import { Link } from 'react-router-dom';
import { BrandMark } from '../components/ui/BrandMark';
import { Button } from '../components/ui/Button';
import { DEMO_BORROWER } from '../deployment';

export default function LandingPage() {
  return (
    <div className="page-wrap page-wrap--center">
      <section className="hero">
        <BrandMark className="hero__mark" />
        <p className="eyebrow">Revoca</p>
        <h1 className="hero__title">A living registry of standing</h1>
        <p className="hero__lede">
          Every position Revoca lends against is a record, continuously attested, and revocable the moment its
          borrower stops qualifying. No stale checks, no manual review, the registry watches in real time.
        </p>
        <div className="hero__actions">
          <Link to="/app">
            <Button>Enter the app</Button>
          </Link>
          <Link to={`/positions/${DEMO_BORROWER}`}>
            <Button variant="ghost">View a live record</Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
