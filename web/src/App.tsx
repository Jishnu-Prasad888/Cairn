import { Navigate, Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import AppShell from './components/AppShell';
import AlbumsPage from './pages/AlbumsPage';
import BrowserPage from './pages/BrowserPage';
import DuplicatesPage from './pages/DuplicatesPage';
import ForbiddenPage from './pages/ForbiddenPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import MemoriesPage from './pages/MemoriesPage';
import PeoplePage from './pages/PeoplePage';
import SettingsPage from './pages/SettingsPage';
import SetupPage from './pages/SetupPage';
import TagsPage from './pages/TagsPage';

export default function App() {
  return (
    <Routes>
      {/* Public: first-run account creation and sign-in. */}
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/signup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* Everything else requires a session. */}
      <Route element={<RequireAuth />}>
        {/* Standalone on purpose — a permission failure replaces the whole UI
            rather than leaving a sidebar of links that will all fail too. */}
        <Route path="/403" element={<ForbiddenPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/browse" element={<BrowserPage />} />
          <Route path="/memories" element={<MemoriesPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/duplicates" element={<DuplicatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
