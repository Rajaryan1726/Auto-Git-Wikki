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
import { PricingPage } from '../pages/pricing-page';
import { ContactPage, PrivacyPage, RefundPolicyPage, TermsPage } from '../pages/policy-pages';
import { PublicLayout } from '../components/public-layout';

export const router = createBrowserRouter([
  {
    element: <RedirectIfAuthed />,
    children: [{ path: '/login', element: <LoginPage /> }],
  },
  // Public (signed in or not): pricing and the policy pages.
  {
    element: <PublicLayout />,
    children: [
      { path: '/pricing', element: <PricingPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/privacy', element: <PrivacyPage /> },
      { path: '/refund-policy', element: <RefundPolicyPage /> },
      { path: '/contact', element: <ContactPage /> },
    ],
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
