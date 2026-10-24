import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseMangaFireHTML } from '../src/extractors/mangafire.ts';
import { parseComixHTML } from '../src/extractors/comix.ts';
import { parseManhuaUSHTML } from '../src/extractors/manhuaus.ts';
import { createScrapingServer } from '../src/server.ts';

test('parseMangaFireHTML should extract images and non-linear navigation slugs', () => {
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div id="reader" data-next="chapter-15-pt2" data-prev="chapter-14">
          <img src="https://static.mfcdn.to/manga/cover-thumb.jpg" alt="cover" />
          <img data-url="https://static.mfcdn.to/manga/page-001.jpg" alt="page 1" />
          <img data-url="https://static.mfcdn.to/manga/page-002.jpg" alt="page 2" />
          <img src="https://static.mfcdn.to/manga/page-003.jpg" alt="page 3" />
        </div>
      </body>
    </html>
  `;

  const result = parseMangaFireHTML(mockHtml, 15);

  assert.equal(result.success, true);
  assert.equal(result.domain, 'mangafire.to');
  assert.equal(result.chapter, 15);
  assert.equal(result.totalImages, 3);
  assert.equal(result.images[0].url, 'https://static.mfcdn.to/manga/page-001.jpg');
  assert.equal(result.images[1].url, 'https://static.mfcdn.to/manga/page-002.jpg');
  assert.equal(result.images[2].url, 'https://static.mfcdn.to/manga/page-003.jpg');
  assert.equal(result.nextChapter, 'chapter-15-pt2');
  assert.equal(result.prevChapter, 'chapter-14');
});

test('parseComixHTML should extract clean image list without referer requirement', () => {
  const mockHtml = `
    <div class="reading-content">
      <img src="https://cdn.comix.to/chapters/101/01.webp" />
      <img src="https://cdn.comix.to/chapters/101/02.webp" />
      <img src="https://cdn.comix.to/chapters/101/03.webp" />
    </div>
  `;

  const result = parseComixHTML(mockHtml, 101);

  assert.equal(result.success, true);
  assert.equal(result.domain, 'comix.to');
  assert.equal(result.chapter, 101);
  assert.equal(result.totalImages, 3);
  assert.equal(result.images[0].url, 'https://cdn.comix.to/chapters/101/01.webp');
  assert.equal(result.images[2].url, 'https://cdn.comix.to/chapters/101/03.webp');
});

test('parseManhuaUSHTML should extract images bypassing turnstile dom wrappers', () => {
  const mockHtml = `
    <div class="entry-content">
      <div class="page-break">
        <img class="wp-manga-chapter-img" src="https://manhuaus.com/upload/manga_123/ch_5/p1.jpeg" />
      </div>
      <div class="page-break">
        <img class="wp-manga-chapter-img" src="https://manhuaus.com/upload/manga_123/ch_5/p2.jpeg" />
      </div>
    </div>
  `;

  const result = parseManhuaUSHTML(mockHtml, 5);

  assert.equal(result.success, true);
  assert.equal(result.domain, 'manhuaus.com');
  assert.equal(result.chapter, 5);
  assert.equal(result.totalImages, 2);
  assert.equal(result.images[0].url, 'https://manhuaus.com/upload/manga_123/ch_5/p1.jpeg');
  assert.equal(result.images[1].url, 'https://manhuaus.com/upload/manga_123/ch_5/p2.jpeg');
});

test('createScrapingServer /healthz endpoint returns healthy status', async () => {
  const mockPool: any = {
    getStats: () => ({ activeWorkers: 0, maxWorkers: 3, queuedTasks: 0 })
  };
  const server = createScrapingServer(mockPool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const port = address.port;

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  assert.equal(data.status, 'ok');
  assert.equal(data.pool.maxWorkers, 3);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('createScrapingServer /extract-chapter returns 400 when url or domain is missing', async () => {
  const mockPool: any = {
    getStats: () => ({ activeWorkers: 0, maxWorkers: 3, queuedTasks: 0 })
  };
  const server = createScrapingServer(mockPool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const port = address.port;

  const res = await fetch(`http://127.0.0.1:${port}/extract-chapter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter: 1 })
  });

  assert.equal(res.status, 400);
  const data = await res.json() as any;
  assert.equal(data.success, false);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});
