import { Navigate, Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import { LibrariesProvider } from './api/libraries';
import AppShell from './components/AppShell';
import AlbumsPage from './pages/AlbumsPage';
import BackupsPage from './pages/BackupsPage';
import BrowsePage from './pages/BrowsePage';
import DuplicatesPage from './pages/DuplicatesPage';
import FavoritesPage from './pages/FavoritesPage';
import ForbiddenPage from './pages/ForbiddenPage';
import HomePage from './pages/HomePage';
import LibrariesPage from './pages/LibrariesPage';
import LoginPage from './pages/LoginPage';
import MediaHub from './pages/MediaHub';
import MemoriesPage from './pages/MemoriesPage';
import MLPage from './pages/MLPage';
import PeoplePage from './pages/PeoplePage';
import PermissionsPage from './pages/PermissionsPage';
import PublicSharePage from './pages/PublicSharePage';
import SettingsPage from './pages/SettingsPage';
import SetupPage from './pages/SetupPage';
import SharingPage from './pages/SharingPage';
import TagsPage from './pages/TagsPage';
import TrashPage from './pages/TrashPage';

export default function App() {
  return (
    <LibrariesProvider>
      <Routes>
        {/* Public routes */}
        <Route path="/s/:token" element={<PublicSharePage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/signup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />

        <Route element={<RequireAuth />}>
          <Route path="/403" element={<ForbiddenPage />} />
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />

            {/* Unified media browser */}
            <Route path="/media" element={<MediaHub />} />
            <Route path="/browse" element={<BrowsePage />} />

            {/* Legacy routes redirect to the unified page */}
            <Route path="/photos" element={<Navigate to="/media?type=photo" replace />} />
            <Route path="/videos" element={<Navigate to="/media?type=video" replace />} />
            <Route path="/files" element={<Navigate to="/media?type=other" replace />} />

            <Route path="/memories" element={<MemoriesPage />} />
            <Route path="/memories/:memoryId" element={<MemoriesPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/shared" element={<SharingPage />} />

            <Route path="/duplicates" element={<DuplicatesPage />} />
            <Route path="/libraries" element={<LibrariesPage />} />
            <Route path="/permissions" element={<PermissionsPage />} />
            <Route path="/ml" element={<MLPage />} />
            <Route path="/backups" element={<BackupsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </LibrariesProvider>
  );
}
