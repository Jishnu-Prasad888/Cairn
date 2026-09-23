import { Route, Routes } from 'react-router-dom';

import HomePage from './pages/HomePage';
import MemoriesPage from './pages/MemoriesPage';
import PeoplePage from './pages/PeoplePage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/memories" element={<MemoriesPage />} />
      <Route path="/people" element={<PeoplePage />} />
    </Routes>
  );
}
