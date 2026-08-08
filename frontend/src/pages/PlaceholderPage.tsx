import type { ReactNode } from 'react';
import { Card } from '../components/ui/Card';

/** A page not built yet, still dressed in the app's own system (not a blank route), so the shell reads as one product while feature surfaces land one at a time. */
export function PlaceholderPage({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return (
    <div className="page-wrap">
      <Card className="placeholder">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="placeholder__title">{title}</h1>
        <p className="placeholder__lede">{description}</p>
        {children}
      </Card>
    </div>
  );
}
