import fs from 'node:fs';
import path from 'node:path';
import type { ChapterExtractionResult, ChapterImageResult } from '../types.ts';

let cachedConfig: string | null = null;
let cachedBuild: string | null = null;
let polyfillLoaded = false;
const polyfillPath = path.resolve('/tmp/mangafire_polyfill.js');

async function ensurePolyfill(): Promise<void> {
  if (polyfillLoaded && cachedConfig && cachedBuild && (globalThis as any).dynamicEncrypt) {
    return;
  }

  const html = await fetch('https://mangafire.to/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  }).then(r => r.text());

  const configMatch = html.match(/window\.__config\s*=\s*["']([^"']+)["']/);
  const buildMatch = html.match(/window\.__build\s*=\s*["']([^"']+)["']/);
  const polyMatch = html.match(/https:\/\/[^"'\s<>]*polyfill[^"'\s<>]*\.js/);

  if (!configMatch || !buildMatch || !polyMatch) {
    throw new Error('Failed to find MangaFire config, build, or polyfill in homepage');
  }

  cachedConfig = configMatch[1];
  cachedBuild = buildMatch[1];

  (globalThis as any).navigator = { appCodeName: 'Mozilla', userAgent: 'Mozilla/5.0' };
  (globalThis as any).window = globalThis;
  (globalThis as any).document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, style: {} }),
    body: { appendChild: () => {} }
  };
  (globalThis as any).location = { href: 'https://mangafire.to/', origin: 'https://mangafire.to' };
  (globalThis as any).__config = cachedConfig;
  (globalThis as any).__build = cachedBuild;
  (globalThis as any).window.__config = cachedConfig;
  (globalThis as any).window.__build = cachedBuild;

  const polyCode = await fetch(polyMatch[0]).then(r => r.text());
  fs.writeFileSync(polyfillPath, polyCode, 'utf-8');
  await import(`file://${polyfillPath}`);
  polyfillLoaded = true;
}

function generateVRF(endpointPath: string): string {
  if (typeof (globalThis as any).dynamicEncrypt !== 'function') {
    throw new Error('MangaFire dynamicEncrypt is not available');
  }
  return (globalThis as any).dynamicEncrypt(endpointPath);
}

async function apiRequest(endpointPath: string): Promise<any> {
  const vrf = generateVRF(endpointPath);
  const sep = endpointPath.includes('?') ? '&' : '?';
  const url = `https://mangafire.to/api${endpointPath}${sep}vrf=${encodeURIComponent(vrf)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://mangafire.to/'
    }
  });

  if (!res.ok) {
    throw new Error(`MangaFire API returned ${res.status}`);
  }

  return res.json();
}

/**
 * Pure parsing function to extract MangaFire images and non-linear navigation from HTML/DOM.
 */
export function parseMangaFireHTML(html: string, chapter: number): ChapterExtractionResult {
  const images: ChapterImageResult[] = [];

  // Match <img> tags inside reader wrapper or with data-url/src
  const imgRegex = /<img[^>]+(?:data-url|data-src|src)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = imgRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    // Filter out icons, logos, trackers, covers and thumbnails
    const isImageFile = /\.(?:jpe?g|png|webp|avif)(?:\?.*)?$/i.test(rawUrl);
    const isIgnored = rawUrl.includes('thumb') || rawUrl.includes('cover') || rawUrl.includes('avatar') || rawUrl.includes('logo');

    if (rawUrl && isImageFile && !isIgnored && (rawUrl.includes('mfcdn') || rawUrl.includes('/manga/') || rawUrl.includes('/images/'))) {
      images.push({
        index: index++,
        url: rawUrl.trim()
      });
    }
  }

  // Extract next and prev non-linear navigation slugs
  let nextChapter: string | undefined;
  let prevChapter: string | undefined;

  const nextMatch = html.match(/data-next=["']([^"']+)["']/i) || html.match(/href=["']([^"']+)["'][^>]*class=["'][^"']*next[^"']*["']/i);
  if (nextMatch) nextChapter = nextMatch[1];

  const prevMatch = html.match(/data-prev=["']([^"']+)["']/i) || html.match(/href=["']([^"']+)["'][^>]*class=["'][^"']*prev[^"']*["']/i);
  if (prevMatch) prevChapter = prevMatch[1];

  return {
    success: images.length > 0,
    domain: 'mangafire.to',
    chapter,
    images,
    totalImages: images.length,
    nextChapter,
    prevChapter
  };
}

/**
 * Headless / API extraction routine for MangaFire.
 */
export async function extractMangaFire(page: any, url: string, chapter: number): Promise<ChapterExtractionResult> {
  // Strategy 1: Fast direct API extraction via dynamic VRF token (ADR-0003 & ADR-0006)
  try {
    await ensurePolyfill();

    // Parse HID and chapter identifier from url
    const cleanUrl = url.split('?')[0].replace(/\/$/, '');
    const titleMatch = cleanUrl.match(/\/title\/([^/]+)/);
    const chapterMatch = cleanUrl.match(/\/title\/[^/]+\/chapter\/([^/]+)/);

    let hid: string | null = null;
    if (titleMatch) {
      const parts = titleMatch[1].split('-');
      hid = parts[0] || null;
    }

    let chapterId: number | null = null;
    const rawParam = chapterMatch ? chapterMatch[1] : String(chapter);

    if (rawParam && !isNaN(Number(rawParam))) {
      const val = Number(rawParam);
      if (val >= 100000) {
        chapterId = val;
      }
    }

    if (!chapterId && hid) {
      // Resolve chapter ID from title chapters listing (paginated up to 5 pages)
      const targetNum = chapter || (rawParam && !isNaN(Number(rawParam)) ? Number(rawParam) : 1);
      let pageNum = 1;
      while (pageNum <= 5) {
        const queryPath = pageNum > 1 ? `/titles/${hid}/chapters?page=${pageNum}` : `/titles/${hid}/chapters`;
        const titleRes = await apiRequest(queryPath);
        const items = titleRes?.items || [];
        const matched = items.find((it: any) => Number(it.number) === targetNum);
        if (matched && matched.id) {
          chapterId = Number(matched.id);
          break;
        }
        if (!titleRes?.meta?.hasNext) {
          break;
        }
        pageNum++;
      }
    }

    if (chapterId) {
      const chData = await apiRequest(`/chapters/${chapterId}`);
      const rawPages = chData?.data?.pages || [];
      const images: ChapterImageResult[] = [];

      for (let i = 0; i < rawPages.length; i++) {
        const item = rawPages[i];
        const imgUrl = typeof item === 'string' ? item : item?.url;
        if (imgUrl) {
          images.push({
            index: i + 1,
            url: imgUrl.trim()
          });
        }
      }

      if (images.length > 0) {
        return {
          success: true,
          domain: 'mangafire.to',
          chapter: Number(chData?.data?.number) || chapter,
          images,
          totalImages: images.length,
          nextChapter: chData?.data?.next?.id ? String(chData.data.next.id) : undefined,
          prevChapter: chData?.data?.prev?.id ? String(chData.data.prev.id) : undefined
        };
      }
    }
  } catch (err: any) {
    // API failed, proceed to headless fallback
    console.warn(`[MangaFire] API extraction failed, using Puppeteer fallback: ${err.message}`);
  }

  // Strategy 2: Headless Puppeteer fallback
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Referer': 'https://mangafire.to/'
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {});
  await page.waitForSelector('#reader, .reader-area, img[src*="mfcdn"]', { timeout: 10000 }).catch(() => {});

  const html = await page.content();
  return parseMangaFireHTML(html, chapter);
}
