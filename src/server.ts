import http from 'http';
import { collectCover, collectCatalog, collectChapter, collectImage } from './cover-collector.ts';
import { BrowserPool } from './browser-pool.ts';
import type { ChapterExtractionRequest, ChapterExtractionResult } from './types.ts';
import { extractMangaFire } from './extractors/mangafire.ts';
import { extractComix } from './extractors/comix.ts';
import { extractManhuaUS } from './extractors/manhuaus.ts';

export function createScrapingServer(pool?: BrowserPool): http.Server {
  const browserPool = pool || new BrowserPool(Number(process.env.MAX_CONCURRENT_BROWSERS) || 3);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && (req.url === '/collect-cover' || req.url === '/collect-catalog')) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) { res.writeHead(413); res.end(); return; }
      }
      try {
        const payload = JSON.parse(body);
        if (req.url === '/collect-catalog') {
          const catalog = await collectCatalog(payload.domain, payload.query || '', payload.page || 1);
          res.writeHead(200);
          res.end(JSON.stringify(catalog));
          return;
        }
        const cover = await collectCover(payload.pageURL, payload.imageURL);
        res.writeHead(200, { 'Content-Type': cover.type, 'X-Cover-Source': cover.source });
        res.end(cover.bytes);
      } catch (error: any) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

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
          const normDomain = payload.domain.replace(/^www\./, '').toLowerCase();

          if (normDomain.includes('mangafire')) {
            result = await browserPool.withPage(page => extractMangaFire(page, payload.url, payload.chapter || 1));
          } else if (normDomain.includes('comix')) {
            result = await browserPool.withPage(page => extractComix(page, payload.url, payload.chapter || 1));
          } else if (normDomain.includes('manhuaus') || normDomain.includes('ravenscans') || normDomain.includes('manhuatop')) {
            const targetDomain = normDomain.includes('manhuaus') ? 'manhuaus.com' : (normDomain.includes('ravenscans') ? 'ravenscans.org' : 'manhuatop.org');
            const data = await collectChapter(payload.url, targetDomain, payload.chapter || 1);
            const images = (data.images || []).map((u, idx) => ({ index: idx + 1, url: u }));
            result = {
              success: images.length > 0,
              domain: payload.domain,
              chapter: payload.chapter || 1,
              images,
              totalImages: images.length,
              nextChapter: data.nextUrl || undefined,
              prevChapter: data.prevUrl || undefined
            };
          } else {
            // Headless extraction fallback (handles Cloudflare Turnstile, RavenScans, ManhuaTop, etc.)
            result = await browserPool.withPage(async (page) => {
              await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
              if (payload.domain.includes('ravenscans')) {
                await page.setExtraHTTPHeaders({ 'Referer': 'https://ravenscans.org/' });
              } else if (payload.domain.includes('manhuatop')) {
                await page.setExtraHTTPHeaders({ 'Referer': 'https://manhuatop.org/' });
              }

              await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});

              // Bypass Cloudflare challenge if present
              for (let i = 0; i < 25; i++) {
                const title = (await page.title()).toLowerCase();
                const isChallenge = title.includes('just a moment') ||
                                    title.includes('um momento') ||
                                    title.includes('cloudflare') ||
                                    title.includes('attention required');
                if (!isChallenge) break;

                for (const frame of page.frames()) {
                  if (frame.url().includes('cloudflare') || frame.url().includes('challenges')) {
                    const checkbox = await frame.$('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
                    if (checkbox) {
                      const box = await checkbox.boundingBox();
                      if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                      }
                    }
                  }
                }
                await new Promise(r => setTimeout(r, 1000));
              }

              // Wait for reader container
              await page.waitForSelector('#readerarea, #chapter-reader, .reading-content, .entry-content, img', { timeout: 12000 }).catch(() => {});

              // Extract images from page
              const rawImgs = await page.evaluate(() => {
                // RavenScans ts_reader check
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                  const m = s.textContent?.match(/ts_reader\.run\(\s*({.*?})\s*\);/s);
                  if (m) {
                    try {
                      const data = JSON.parse(m[1].replace(/\\\//g, '/'));
                      if (data.sources?.[0]?.images?.length > 0) {
                        return data.sources[0].images;
                      }
                    } catch {}
                  }
                }

                const elements = Array.from(document.querySelectorAll('#readerarea img, #chapter-reader img, .reading-content img, .entry-content img, .wp-manga-chapter-img, img')) as HTMLImageElement[];
                const valid = elements
                  .map(img => (img.getAttribute('data-src') || img.src || '').trim())
                  .filter(src => {
                    if (!src || src.startsWith('data:')) return false;
                    const l = src.toLowerCase();
                    return !l.includes('logo') && !l.includes('avatar') && !l.includes('banner') && !l.includes('readerarea.svg') && !l.includes('icon');
                  });
                return Array.from(new Set(valid));
              });

              const images = (rawImgs || []).map((u: string, idx: number) => ({
                index: idx + 1,
                url: u
              }));

              console.log(`[Worker] Extracted ${payload.domain}: final title="${await page.title()}", images=${images.length}`);

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
          console.error(`[Worker] Extraction error:`, err);
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: err.message || 'Internal extractor error'
          }));
        }
      });
      return;
    }

    // Image streaming endpoint for protected domains
    if (req.method === 'GET' && req.url?.startsWith('/stream-image')) {
      const parsed = new URL(req.url, 'http://localhost:50051');
      const imgURL = parsed.searchParams.get('url');
      if (!imgURL) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'url is required' }));
        return;
      }
      try {
        const result = await collectImage(imgURL);
        res.writeHead(200, {
          'Content-Type': result.type,
          'Content-Length': result.bytes.length,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(result.bytes);
      } catch (err: any) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}
