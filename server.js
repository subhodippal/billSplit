/* Local dev server for SplitEasy: `npm start` → http://localhost:3000
   Serves the static files in this folder with no dependencies.
   Port can be changed with PORT=4000 npm start. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const BLOCKED = /(^|[\\/])(\.env|\.git|node_modules)([\\/.]|$)/;   // never serve secrets or repo internals

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.sql': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (_) { res.writeHead(400).end('Bad request'); return; }

  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || BLOCKED.test(path.relative(ROOT, file))) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'   // always pick up edits on reload
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`SplitEasy running at http://localhost:${PORT}/`);
});
