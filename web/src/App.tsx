import { Navigate, Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import { LibrariesProvider } from './api/libraries';
import AppShell from './components/AppShell';
import AlbumsPage from './pages/AlbumsPage';
import BackupsPage from './pages/BackupsPage';
import BrowsePage from './pages/BrowsePage';
import DuplicatesPage from './pages/DuplicatesPage';
import FavoritesPage from './pages/FavoritesPage';
import FilesPage from './pages/FilesPage';
import ForbiddenPage from './pages/ForbiddenPage';
import HomePage from './pages/HomePage';
import LibrariesPage from './pages/LibrariesPage';
import LoginPage from './pages/LoginPage';
import MemoriesPage from './pages/MemoriesPage';
import MLPage from './pages/MLPage';
import PeoplePage from './pages/PeoplePage';
import PermissionsPage from './pages/PermissionsPage';
import PhotosPage from './pages/PhotosPage';
import PublicSharePage from './pages/PublicSharePage';
import SettingsPage from './pages/SettingsPage';
import SetupPage from './pages/SetupPage';
import SharingPage from './pages/SharingPage';
import TagsPage from './pages/TagsPage';
import TrashPage from './pages/TrashPage';
import VideosPage from './pages/VideosPage';

export default function App() {
  return (
    // The library list is shared by nearly every page, so it is loaded once
    // here rather than per page. It sits above the routes rather than inside
    // the shell so the public share view — which has no session and no library
    // — never triggers it.
    <LibrariesProvider>
      <Routes>
        {/* Public: a share link, first-run account creation, and sign-in. */}
        <Route path="/s/:token" element={<PublicSharePage />} />
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

            {/* Media. Photos, Videos, and Files are one configurable browser;
                `/browse` is the same thing with no type filter, which is where
                the top-bar search lands. */}
            <Route path="/browse" element={<BrowsePage />} />
            <Route path="/photos" element={<PhotosPage />} />
            <Route path="/videos" element={<VideosPage />} />
            <Route path="/files" element={<FilesPage />} />

            <Route path="/memories" element={<MemoriesPage />} />
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
