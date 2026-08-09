import { Link } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';

/** Any unmatched path, including old bookmarks or links, lands here, in the app's own shell and voice, not react-router's raw dev error screen. */
export default function NotFoundPage() {
  return (
    <div className="page-wrap">
      <Card className="placeholder">
        <p className="eyebrow">404</p>
        <h1 className="placeholder__title">This page doesn&rsquo;t exist.</h1>
        <p className="placeholder__lede">
          Whatever you were looking for isn&rsquo;t here. The lending app, the positions registry, and the docs all
          are.
        </p>
        <div style={{ marginTop: '1.5rem' }}>
          <Link to="/lend">
            <Button>Go to the app</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
