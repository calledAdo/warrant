import { Component, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans/wght.css';
import './styles.css';

const Customer = lazy(() => import('./customer'));
const Admin = lazy(() => import('./admin'));

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="app-fallback"><h1>This page needs a fresh start.</h1><p>Your saved reports are still available. Reload to continue.</p><button className="button button-primary" onClick={() => location.reload()}>Reload page</button></main> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><Suspense fallback={<div className="app-fallback" role="status">Opening Warrant…</div>}>{['/admin', '/admin.html'].includes(location.pathname) ? <Admin /> : <Customer />}</Suspense></ErrorBoundary>);
