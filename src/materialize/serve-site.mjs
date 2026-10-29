import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function serveStaticDirectory(rootDir) {
  const resolvedRoot = resolve(rootDir);

  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      try {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(urlObj.pathname);
        if (pathname === '/') pathname = '/index.html';

        const candidate = resolve(resolvedRoot, '.' + pathname);
        if (!candidate.startsWith(resolvedRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        let targetFile = candidate;
        if (existsSync(targetFile) && statSync(targetFile).isDirectory()) {
          targetFile = join(targetFile, 'index.html');
        }

        // SPA history fallback for clean client-side routes (e.g. /forum, /checkout, /courses)
        if (!existsSync(targetFile) && !extname(pathname)) {
          const spaFallback = join(resolvedRoot, 'index.html');
          if (existsSync(spaFallback)) targetFile = spaFallback;
        }

        if (!existsSync(targetFile) || !statSync(targetFile).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = extname(targetFile).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        const data = readFileSync(targetFile);
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    });

    server.on('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      resolvePromise({
        url,
        port: addr.port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
