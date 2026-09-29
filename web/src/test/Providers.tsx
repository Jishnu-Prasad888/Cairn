/**
 * The providers every route in the app sits inside.
 *
 * Kept in its own file so a component test that needs its own `<Routes>` — the
 * app shell, which renders an `Outlet` — can get the same context
 * `renderPage` provides instead of hand-assembling the providers and drifting.
 */

import type { ReactNode } from 'react';

import { LibrariesProvider } from '../api/libraries';
import AuthProvider from '../auth/AuthProvider';

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <LibrariesProvider>{children}</LibrariesProvider>
    </AuthProvider>
  );
}
