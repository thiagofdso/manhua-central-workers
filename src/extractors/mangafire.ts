import type { ChapterExtractionResult, ChapterImageResult } from '../types.ts';

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
 * Headless extraction routine for MangaFire.
 */
export async function extractMangaFire(page: any, url: string, chapter: number): Promise<ChapterExtractionResult> {
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Referer': 'https://mangafire.to/'
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for reader content
  await page.waitForSelector('#reader, .reader-area, body', { timeout: 10000 }).catch(() => {});

  const html = await page.content();
  return parseMangaFireHTML(html, chapter);
}
