import { createBrowserRouter } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import LandingPage from './pages/LandingPage';
import AppHomePage from './pages/AppHomePage';
import LendPage from './pages/LendPage';
import PositionsPage from './pages/PositionsPage';
import RecordPage from './pages/RecordPage';
import PoolPage from './pages/PoolPage';
import DocsPage from './pages/DocsPage';

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/app', element: <AppHomePage /> },
      { path: '/lend', element: <LendPage /> },
      { path: '/positions', element: <PositionsPage /> },
      { path: '/positions/:address', element: <RecordPage /> },
      { path: '/pool', element: <PoolPage /> },
      { path: '/docs', element: <DocsPage /> },
    ],
  },
]);
