import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { BeaconPage } from './pages/Beacon';
import { TryPage } from './pages/Try';
import { DocsPage } from './pages/Docs';
import { CommitteePage } from './pages/Committee';
import { REPO } from './lib/config';

export function App() {
  return (
    <HashRouter>
      <header className="top">
        <NavLink to="/" className="wordmark" aria-label="RNG home">
          <span className="mark" aria-hidden="true"><i /><i /><i /><i /></span>RNG
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/" end>Beacon</NavLink>
          <NavLink to="/try">Try a draw</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <NavLink to="/committee">Committee</NavLink>
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<BeaconPage />} />
          <Route path="/try" element={<TryPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/committee" element={<CommitteePage />} />
        </Routes>
      </main>
      <footer className="foot">
        Testnet. Rounds are signed by a 2-of-3 committee run by RandAO Labs; seats open to outside operators as the network grows.
      </footer>
    </HashRouter>
  );
}
