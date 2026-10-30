import puppeteer, { type Browser, type Page } from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';

const domains = new Set(['manhuaus.com', 'ravenscans.org', 'manhuatop.org']);
const browsers = new Map<string, Browser>();
const verificationPages = new Map<string, Page>();
const workingPages = new Map<string, Page>();
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let closing = false;
let nextSourceAccess = 0;

function enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const task = queue.then(() => {
    signal?.throwIfAborted();
    return action();
  });
  queue = task.catch(() => undefined);
  return task;
}

export async function closeCoverBrowsers(): Promise<void> {
  closing = true;
  clearTimeout(idleTimer);
  await Promise.all([...browsers.values()].map(browser => browser.close().catch(() => undefined)));
  browsers.clear();
  verificationPages.clear();
  workingPages.clear();
}

export function collectCover(pageURL: string, imageURL?: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string; source: string }> {
  return enqueue(() => download(pageURL, imageURL, signal), signal);
}

export function collectImage(imageURL: string, pageURL?: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string; source: string }> {
  const target = new URL(imageURL);
  let baseDomain = target.hostname.replace(/^www\./, '');
  for (const d of domains) {
    if (baseDomain === d || baseDomain.endsWith('.' + d)) {
      baseDomain = d;
      break;
    }
  }
  const refPage = pageURL || `https://${baseDomain}/`;
  return enqueue(() => withSourcePage(refPage, 'body', async (page) => {
    await page.setExtraHTTPHeaders({ Referer: `https://${baseDomain}/` });
    try {
      const data = await page.evaluate(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const type = res.headers.get('content-type') || 'image/webp';
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return { b64: btoa(binary), type };
      }, target.href);
      return { bytes: Buffer.from(data.b64, 'base64'), type: data.type, source: target.href };
    } catch {
      const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (!response || response.status() !== 200) throw new Error(`Image request blocked: HTTP ${response?.status()}`);
      const bytes = await response.buffer();
      const type = response.headers()['content-type'] || 'image/webp';
      return { bytes, type, source: target.href };
    }
  }, signal), signal);
}

async function download(pageURL: string, imageURL?: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string; source: string }> {
  return withSourcePage(pageURL, '.thumb img,.summary_image img,meta[property="og:image"]', async (page, origin) => {
    const domain = origin.hostname.replace(/^www\./, '');
    const source = imageURL || await page.evaluate(() => {
      const img = document.querySelector('.thumb img,.summary_image img');
      return img?.getAttribute('data-src') || img?.getAttribute('src') || document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    });
    const target = new URL(source, pageURL);
    if (target.protocol !== 'https:' || target.port || !(target.hostname === domain || target.hostname.endsWith('.' + domain))) throw new Error('Cover outside source domain');
    await page.setExtraHTTPHeaders({ Referer: origin.origin + '/' });
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response || response.status() !== 200) throw new Error('Cover request blocked');
    if (Number(response.headers()['content-length'] || 0) > 8 * 1024 * 1024) throw new Error('Cover too large');
    const bytes = await response.buffer();
    const type = response.headers()['content-type'] || '';
    if (bytes.length > 8 * 1024 * 1024 || !type.startsWith('image/')) throw new Error('Invalid cover response');
    return { bytes, type, source: target.href };
  }, signal);
}

export function collectCatalog(domain: string, query: string, pageNumber: number, signal?: AbortSignal) {
  if (!domains.has(domain) || !Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('Invalid catalog request');
  const url = new URL(domain === 'manhuaus.com' ? (pageNumber === 1 ? '/manga/' : `/manga/page/${pageNumber}/`) : '/manga/', 'https://' + domain);
  if (query) {
    if (domain === 'manhuaus.com') {
      url.pathname = pageNumber === 1 ? '/' : `/page/${pageNumber}/`;
      url.searchParams.set('post_type', 'wp-manga');
    }
    url.searchParams.set('s', query);
  }
  if (domain === 'ravenscans.org') {
    url.searchParams.set('page', String(pageNumber));
    if (!query) url.searchParams.set('order', 'update');
  }
  return enqueue(() => withSourcePage(url.href, '.page-item-detail,.c-tabs-item__content,.bsx', async page => page.evaluate((domain, pageNumber) => {
    const items = [];
    const seen = new Set<string>();
    for (const card of document.querySelectorAll('.page-item-detail,.c-tabs-item__content,.bsx')) {
      const link = card.querySelector<HTMLAnchorElement>('.post-title a,.tt a,h3 a,a[href*="/manga/"]');
      if (!link) continue;
      const slug = new URL(link.href).pathname.match(/\/manga\/([^/]+)/)?.[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const title = (card.querySelector('.post-title,.tt,h3')?.textContent || link.title || link.textContent || '').trim();
      if (!title) continue;
      const image = card.querySelector<HTMLImageElement>('img');
      const rawCover = image?.getAttribute('data-src') || image?.getAttribute('data-lazy-src') || image?.getAttribute('data-original') || image?.getAttribute('src') || '';
      const chapter = card.querySelector('.chapter-item,.latest-chap,.chapter,.epxs')?.textContent?.match(/(?:chapter|ch\.?)?\s*(\d+)/i)?.[1];
      items.push({ title, slug, primaryDomain: domain, urlTemplate: domain === 'manhuaus.com' ? `https://${domain}/manga/${slug}/chapter-{chapter}/` : `https://${domain}/${slug}-chapter-{chapter}/`, coverUrl: rawCover && !rawCover.startsWith('data:') ? new URL(rawCover, location.href).href : '', lastChapter: chapter ? Number(chapter) : undefined });
    }
    let totalPages = Number((document.title + ' ' + (document.querySelector('.wp-pagenavi .pages')?.textContent || '')).match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] || pageNumber);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('.wp-pagenavi a,.pagination a,.nav-links a,a.page-numbers')) {
      const number = Number(link.href.match(/(?:\/page\/|[?&]page=)(\d+)/)?.[1] || link.textContent?.trim());
      if (Number.isFinite(number)) totalPages = Math.max(totalPages, number);
    }
    if (document.querySelector('link[rel="next"],a.next,a.nextpostslink,#navigation-ajax') && items.length) totalPages = Math.max(totalPages, pageNumber + 1);
    return { items, page: pageNumber, totalPages };
  }, domain, pageNumber), signal), signal);
}

async function withSourcePage<Result>(pageURL: string, selector: string, action: (page: Page, origin: URL) => Promise<Result>, signal?: AbortSignal): Promise<Result> {
  if (closing) throw new Error('Cover collector is shutting down');
  const origin = new URL(pageURL);
  const domain = origin.hostname.replace(/^www\./, '');
  if (!domains.has(domain) || origin.protocol !== 'https:' || origin.port) throw new Error('Unsupported cover domain');
  clearTimeout(idleTimer);
  let browser = browsers.get(domain);
  if (!browser?.connected) {
    const profile = path.join(process.env.COVER_PROFILES_DIR || '/data/cover-profiles', domain);
    await fs.mkdir(profile, { recursive: true });
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await fs.rm(path.join(profile, lockFile), { force: true }).catch(() => undefined);
    }
    browser = await puppeteer.launch({
      executablePath: process.env.COVER_BROWSER_EXECUTABLE,
      headless: process.env.COVER_BROWSER_HEADLESS === 'true',
      userDataDir: profile,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,1000']
    });
    browsers.set(domain, browser);
    console.log(`[Cover collector] Browser started for ${domain}: ${await browser.version()}`);
  }
  let page = workingPages.get(domain);
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    workingPages.set(domain, page);
  }
  const activePage = page;
  const cancel = () => {
    if (verificationPages.get(domain) !== activePage) {
      workingPages.delete(domain);
      void activePage.close().catch(() => undefined);
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome/', 'Chrome/'));
    const interval = Math.max(0, Number(process.env.CATALOG_COLLECTOR_INTERVAL_MS) || 0);
    if (interval) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextSourceAccess - Date.now())));
      nextSourceAccess = Date.now() + interval;
    }
    const navigation = await page.goto(pageURL, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => null);
    signal?.throwIfAborted();

    // Handle Cloudflare Turnstile challenge if present (matching manhuaus_extractor.mjs)
    const manualWait = Math.max(0, Number(process.env.CATALOG_COLLECTOR_MANUAL_WAIT_MS) || 0);
    const challengeDeadline = Date.now() + 30000;
    for (; Date.now() < challengeDeadline;) {
      signal?.throwIfAborted();
      const title = (await page.title().catch(() => '')).toLowerCase();
      const isChallenge = title.includes('just a moment') ||
                          title.includes('um momento') ||
                          title.includes('cloudflare') ||
                          title.includes('attention required');
      if (!isChallenge) break;

      for (const frame of page.frames()) {
        const fUrl = frame.url();
        if (fUrl.includes('cloudflare') || fUrl.includes('challenges')) {
          try {
            const checkbox = await frame.$('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label, #cf-stage');
            if (checkbox) {
              const box = await checkbox.boundingBox();
              if (box) {
                console.log(`[Turnstile] Clicking checkbox in frame ${fUrl} at (${box.x}, ${box.y})`);
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              }
            }
          } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (manualWait) {
      const title = (await page.title().catch(() => '')).toLowerCase();
      if (title.includes('just a moment') || title.includes('um momento') || title.includes('cloudflare') || title.includes('attention required')) {
        const existing = verificationPages.get(domain);
        if (!existing || existing.isClosed()) {
          verificationPages.set(domain, page);
          workingPages.delete(domain);
        }
        throw new Error(`Source requires manual verification: ${domain}, HTTP ${navigation?.status()}`);
      }
      const existing = verificationPages.get(domain);
      if (existing && (existing.isClosed() || !/just a moment|um momento|cloudflare|attention required/i.test(await existing.title().catch(() => '')))) {
        verificationPages.delete(domain);
        await existing.close().catch(() => undefined);
      }
    }

    try {
      await page.waitForSelector(selector, { timeout: 20000 });
    } catch {
      const title = (await page.title().catch(() => '')).toLowerCase();
      const isChallenge = title.includes('just a moment') ||
                          title.includes('um momento') ||
                          title.includes('cloudflare') ||
                          title.includes('attention required');
      if (isChallenge) {
        throw new Error(`Source did not release content: HTTP ${navigation?.status()}, title=${title}, browser=${await browser.version()}`);
      }
    }
    const result = await action(page, origin);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (page.isClosed()) workingPages.delete(domain);
    idleTimer = setTimeout(() => {
      for (const [domain, browser] of browsers) {
        const verification = verificationPages.get(domain);
        if (verification && !verification.isClosed()) continue;
        verificationPages.delete(domain);
        workingPages.delete(domain);
        void browser.close();
        browsers.delete(domain);
      }
    }, 300000);
    idleTimer.unref();
  }
}

export function collectChapter(pageURL: string, domain: string, chapter: number = 1, signal?: AbortSignal): Promise<{ images: string[]; nextUrl?: string | null; prevUrl?: string | null }> {
  const normDomain = domain.replace(/^www\./, '');
  if (!domains.has(normDomain)) throw new Error(`Unsupported chapter collection domain: ${normDomain}`);

  return enqueue(() => withSourcePage(pageURL, '#readerarea img, .reading-content img, .wp-manga-chapter-img, #chapter-reader img, .entry-content img, .reader-image img, #readerarea, .reader-image, .reading-content', async (page) => {
    await new Promise(r => setTimeout(r, 2000));
    const currentTitle = await page.title().catch(() => '');
    console.log(`[collectChapter] for ${normDomain}: title="${currentTitle}"`);
    const evalResult = await page.evaluate(() => {
      // 1. RavenScans ts_reader from full HTML
      const fullHtml = document.documentElement.innerHTML;
      const tsMatch = fullHtml.match(/ts_reader\.run\(\s*({.*?})\s*\);/s);
      if (tsMatch) {
        try {
          const data = JSON.parse(tsMatch[1].replace(/\\\//g, '/'));
          if (data.sources?.[0]?.images?.length > 0) {
            const imgs = data.sources[0].images.map((img: string) => img.trim()).filter(Boolean);
            return { images: imgs, nextUrl: null, prevUrl: null, matched: `ts_reader: ${imgs.length}` };
          }
        } catch (e: any) {}
      }

      // 2. Images in reader containers
      const elements = Array.from(document.querySelectorAll(
        '.reading-content img, .wp-manga-chapter-img, #readerarea img, #chapter-reader img, .entry-content img, .page-break img, #readerarea p img, .reader-image img, div[class*="reader-image"] img, img'
      )) as HTMLImageElement[];
      const valid = elements
        .map(img => (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('src') || '').trim())
        .filter(src => {
          if (!src || src.startsWith('data:') || src.endsWith('.svg') || src.endsWith('.ico')) return false;
          const l = src.toLowerCase();
          return !l.includes('logo') && !l.includes('avatar') && !l.includes('banner') && !l.includes('readerarea.svg') && !l.includes('icon') && !l.includes('about_manhuatop') && !l.includes('wordmark') && !l.includes('pubadx') && !l.includes('doubleclick');
        });

      const nextEl = document.querySelector('a.btn.next_page, a.next_page, a.ch-next-btn, .next_page a') as HTMLAnchorElement | null;
      const prevEl = document.querySelector('a.btn.prev_page, a.prev_page, a.ch-prev-btn, .prev_page a') as HTMLAnchorElement | null;

      return {
        images: Array.from(new Set(valid)),
        nextUrl: nextEl?.href || null,
        prevUrl: prevEl?.href || null,
        matched: `elements: ${elements.length}, valid: ${valid.length}`
      };
    });
    console.log(`[collectChapter] extraction result:`, evalResult.matched);
    return evalResult;
  }, signal), signal);
}
