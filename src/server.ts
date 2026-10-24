import http from 'http';
import { BrowserPool } from './browser-pool.ts';
import type { ChapterExtractionRequest, ChapterExtractionResult } from './types.ts';
import { extractMangaFire } from './extractors/mangafire.ts';
import { extractComix } from './extractors/comix.ts';
import { extractManhuaUS } from './extractors/manhuaus.ts';

export function createScrapingServer(pool?: BrowserPool): http.Server {
  const browserPool = pool || new BrowserPool(Number(process.env.MAX_CONCURRENT_BROWSERS) || 3);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Health check probe
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        pool: browserPool.getStats(),
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // Extraction endpoint
    if (req.method === 'POST' && req.url === '/extract-chapter') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as ChapterExtractionRequest;

          if (!payload.url || !payload.domain) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'url and domain are required' }));
            return;
          }

          let result: ChapterExtractionResult;

          if (payload.domain.includes('mangafire')) {
            result = await browserPool.withPage(page => extractMangaFire(page, payload.url, payload.chapter || 1));
          } else if (payload.domain.includes('comix')) {
            result = await browserPool.withPage(page => extractComix(page, payload.url, payload.chapter || 1));
          } else if (payload.domain.includes('manhuaus')) {
            result = await browserPool.withPage(page => extractManhuaUS(page, payload.url, payload.chapter || 1));
          } else {
            // Generic headless extraction fallback
            result = await browserPool.withPage(async (page) => {
              await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              const images = await page.$$eval('img', (imgs: any[]) =>
                imgs.map((img, idx) => ({ index: idx + 1, url: img.src }))
              );
              return {
                success: images.length > 0,
                domain: payload.domain,
                chapter: payload.chapter || 1,
                images,
                totalImages: images.length
              };
            });
          }

          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: err.message || 'Internal extractor error'
          }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}
