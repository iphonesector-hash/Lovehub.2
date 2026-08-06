// scripts/serve.js
// LoveHub dependency-free static dev/preview server (Node >= 16, no packages).
//
//   node scripts/serve.js             -> http://0.0.0.0:3000
//   PORT=8080 node scripts/serve.js   -> http://0.0.0.0:8080
//
// Binds 0.0.0.0 so Freebuff / Vercel-style preview hosts can reach it, and
// serves the repository root (project files live at the repo top level —
// index.html, style.css, app.js, assets/, services/, src/, supabase/).
// Extensionless paths (PWA deep links) fall back to index.html.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf'
};

function send(res, code, filePath) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            const status = err.code === 'ENOENT' ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(status === 404 ? '404 Not Found' : '500 Internal Server Error');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(code, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    let urlPath;
    try {
        urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
    } catch {
        res.writeHead(400);
        res.end('400 Bad Request');
        return;
    }

    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
    }

    fs.stat(filePath, (err, stat) => {
        if (!err && stat.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        } else if (err || !stat.isFile()) {
            if (!path.extname(filePath)) filePath = path.join(ROOT, 'index.html');
        }
        send(res, 200, filePath);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`LoveHub preview server running at http://${HOST}:${PORT} (root: ${ROOT})`);
});
