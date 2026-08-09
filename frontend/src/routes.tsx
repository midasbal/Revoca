import { createBrowserRouter } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import LandingPage from './pages/LandingPage';
import LendPage from './pages/LendPage';
import PositionsPage from './pages/PositionsPage';
import RecordPage from './pages/RecordPage';
import PoolPage from './pages/PoolPage';
import DocsPage from './pages/DocsPage';
import RoadmapPage from './pages/RoadmapPage';
import NotFoundPage from './pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/lend', element: <LendPage /> },
      { path: '/positions', element: <PositionsPage /> },
      { path: '/positions/:address', element: <RecordPage /> },
      { path: '/pool', element: <PoolPage /> },
      { path: '/docs', element: <DocsPage /> },
      { path: '/roadmap', element: <RoadmapPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
