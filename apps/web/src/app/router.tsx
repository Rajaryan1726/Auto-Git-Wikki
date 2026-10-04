import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from '../components/app-layout';
import { LoginPage } from '../pages/login-page';
import { RepositoriesPage } from '../pages/repositories-page';
import {
  ChatPage,
  NotFoundPage,
  OverviewPage,
  RepoPage,
  SettingsPage,
} from '../pages/placeholder-pages';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <RepositoriesPage /> },
      { path: '/overview', element: <OverviewPage /> },
      { path: '/repos/:id', element: <RepoPage /> },
      { path: '/chat', element: <ChatPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
