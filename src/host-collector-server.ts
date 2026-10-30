import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { collectCatalog, collectCover, collectChapter, collectImage } from './cover-collector.ts';

const allowed = new Set(['manhuaus.com', 'ravenscans.org']);

export function createHostCollector(token: string): http.Server {
  if (!token) throw new Error('CATALOG_COLLECTOR_TOKEN is required');
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const authorization = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.end(JSON.stringify({ status: 'ok', mode: 'host', domains: [...allowed] }));
      return;
    }
    const cancellation = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) cancellation.abort(new Error('Collector client disconnected'));
    });

    if (req.method === 'GET' && req.url?.startsWith('/stream-image')) {
      const parsed = new URL(req.url, 'http://127.0.0.1:50052');
      const imgURL = parsed.searchParams.get('url');
      if (!imgURL) {
        res.writeHead(400).end(JSON.stringify({ error: 'url parameter is required' }));
        return;
      }
      try {
        const result = await collectImage(imgURL, undefined, cancellation.signal);
        res.writeHead(200, {
          'Content-Type': result.type,
          'Content-Length': result.bytes.length,
          'Cache-Control': 'public, max-age=86400, immutable'
        });
        res.end(result.bytes);
      } catch (err: any) {
        console.error('[Host collector stream-image error]', err.message);
        res.writeHead(502).end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method !== 'POST' || !['/collect-catalog', '/collect-cover', '/extract-chapter'].includes(req.url || '')) {
      res.writeHead(404).end();
      return;
    }
    let payload: any;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      payload = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === '/collect-catalog') {
        if (!allowed.has(payload.domain) || !Number.isInteger(payload.page) || payload.page < 1 || typeof payload.query !== 'string') throw new Error('Invalid catalog request');
      } else if (req.url === '/extract-chapter') {
        const norm = (payload.domain || '').replace(/^www\./, '').toLowerCase();
        if (!payload.url || typeof payload.url !== 'string' || !payload.domain || typeof payload.domain !== 'string' || !allowed.has(norm)) throw new Error('Invalid extract-chapter request');
      } else {
        const url = new URL(payload.pageURL);
        if (!allowed.has(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Unsupported source');
        if (payload.imageURL && typeof payload.imageURL !== 'string') throw new Error('Invalid image URL');
      }
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'Invalid request or unsupported domain' }));
      return;
    }
    try {
      if (req.url === '/collect-catalog') {
        const result = await collectCatalog(payload.domain, payload.query, payload.page, cancellation.signal);
        console.log(`[Host collector] ${payload.domain} page=${payload.page} items=${result.items.length}`);
        res.end(JSON.stringify(result));
      } else if (req.url === '/extract-chapter') {
        const normDomain = (payload.domain || '').replace(/^www\./, '').toLowerCase();
        const targetDomain = normDomain.includes('manhuaus') ? 'manhuaus.com' : 'ravenscans.org';
        const data = await collectChapter(payload.url, targetDomain, payload.chapter || 1, cancellation.signal);
        const images = (data.images || []).map((u, idx) => ({ index: idx + 1, url: u }));
        console.log(`[Host collector] Extracted chapter ${payload.chapter} for ${targetDomain}: ${images.length} images`);
        res.end(JSON.stringify({
          success: images.length > 0,
          domain: payload.domain,
          chapter: payload.chapter || 1,
          images,
          totalImages: images.length,
          nextChapter: data.nextUrl || undefined,
          prevChapter: data.prevUrl || undefined
        }));
      } else {
        const cover = await collectCover(payload.pageURL, payload.imageURL, cancellation.signal);
        res.writeHead(200, { 'Content-Type': cover.type, 'X-Cover-Source': cover.source });
        res.end(cover.bytes);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Collection failed';
      console.error('[Host collector]', message);
      res.writeHead(502).end(JSON.stringify({ error: message }));
    }
  });
}
