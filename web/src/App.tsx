import { Route, Routes } from 'react-router-dom';

import AlbumsPage from './pages/AlbumsPage';
import BrowserPage from './pages/BrowserPage';
import DuplicatesPage from './pages/DuplicatesPage';
import HomePage from './pages/HomePage';
import MemoriesPage from './pages/MemoriesPage';
import PeoplePage from './pages/PeoplePage';
import TagsPage from './pages/TagsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/browse" element={<BrowserPage />} />
      <Route path="/memories" element={<MemoriesPage />} />
      <Route path="/people" element={<PeoplePage />} />
      <Route path="/albums" element={<AlbumsPage />} />
      <Route path="/tags" element={<TagsPage />} />
      <Route path="/duplicates" element={<DuplicatesPage />} />
    </Routes>
  );
}
