import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../dist/client/', import.meta.url);
const mime = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' };

// The demo prop that opens the walkthrough: a scripted re-enactment of the
// billing retry that double-charges. It is a single static file outside the
// Vite build, it talks to nothing, and it reads no run or complaint data.
const simulation = new URL('../demo/checkout-sim.html', import.meta.url);

/** Serve only the compiled entry and its flat, content-hashed assets. */
export function serveFrontend(req, res, pathname) {
  if (['/simulation', '/simulation.html'].includes(pathname)) return serveSimulation(req, res);
  const page = ['/', '/index.html', '/admin', '/admin.html'].includes(pathname);
  const asset = /^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname) || pathname === '/favicon.svg';
  if (!page && !asset) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return true;
  }
  const file = new URL(page ? 'index.html' : pathname.slice(1), root);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(page ? 503 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(page ? 'The frontend has not been built. Run npm run build, or use npm run dev for local development.' : 'Asset not found.');
    return true;
  }
  const body = readFileSync(fileURLToPath(file));
  res.writeHead(200, {
    'Content-Type': page ? 'text/html; charset=utf-8' : (mime[pathname.split('.').pop()] || 'application/octet-stream'),
    'Content-Length': body.length,
    'Cache-Control': page ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(page ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'" } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/**
 * The simulation keeps its script inline, so it gets its own policy rather
 * than loosening the app's. It is stricter everywhere else: the page makes no
 * requests at all, so connect-src is closed entirely.
 */
function serveSimulation(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return true;
  }
  if (!existsSync(simulation)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The demo simulation is not installed. Expected demo/checkout-sim.html.');
    return true;
  }
  const body = readFileSync(fileURLToPath(simulation));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
