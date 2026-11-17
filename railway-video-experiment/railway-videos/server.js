// Experimental, single-host reverse proxy. No arbitrary target URLs are accepted.
// It does not rewrite JavaScript, cross-origin player URLs, or DRM.
const http = require('node:http');
const { Readable } = require('node:stream');
const upstream = new URL('https://www.streamex.hn');
const port = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not supported'); return;
  }
  let target;
  try {
    // Construct only a path on the fixed upstream; reject network-path references.
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw Error();
    target = new URL(req.url, upstream);
    if (target.origin !== upstream.origin) throw Error();
  } catch { res.writeHead(400).end('Invalid path'); return; }
  try {
    const response = await fetch(target, {
      method: req.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': req.headers['user-agent'] || 'Mozilla/5.0', 'accept': req.headers.accept || '*/*', ...(req.headers.range ? { range: req.headers.range } : {}) }
    });
    const headers = {};
    // Explicit allowlist: don't forward upstream cookies, CSP, frame headers, or hop-by-hop headers.
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(name); if (value) headers[name] = value;
    }
    const location = response.headers.get('location');
    if (location) {
      const next = new URL(location, target);
      // Do not redirect to an arbitrary external host from the proxy.
      if (next.origin !== upstream.origin && next.hostname !== 'streamex.hn') {
        res.writeHead(502, { 'content-type': 'text/plain' }).end('External redirect not supported by this experiment.'); return;
      }
      headers.location = next.pathname + next.search + next.hash;
    }
    headers['x-content-type-options'] = 'nosniff';
    headers['referrer-policy'] = 'no-referrer';
    res.writeHead(response.status, headers);
    if (req.method === 'HEAD' || !response.body) res.end();
    else Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream unavailable. This experimental proxy may not be compatible with the site.');
  }
}).listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));
