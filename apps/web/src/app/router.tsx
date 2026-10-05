import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from '../components/app-layout';
import { RedirectIfAuthed, RequireAuth } from '../features/auth/route-guards';
import { ChatPage } from '../pages/chat-page';
import { LoginPage } from '../pages/login-page';
import { RepoPage } from '../pages/repo-page';
import { RepositoriesPage } from '../pages/repositories-page';
import { NotFoundPage } from '../pages/placeholder-pages';
import { OverviewPage } from '../pages/overview-page';
import { SettingsPage } from '../pages/settings-page';

export const router = createBrowserRouter([
  {
    element: <RedirectIfAuthed />,
    children: [{ path: '/login', element: <LoginPage /> }],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <RepositoriesPage /> },
          { path: '/overview', element: <OverviewPage /> },
          { path: '/repos/:id', element: <RepoPage /> },
          { path: '/repos/:id/wiki/:slug', element: <RepoPage /> },
          { path: '/chat', element: <ChatPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
