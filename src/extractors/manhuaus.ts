import type { ChapterExtractionResult, ChapterImageResult } from '../types.ts';

/**
 * Pure parsing function to extract ManhuaUS images from HTML/DOM.
 */
export function parseManhuaUSHTML(html: string, chapter: number): ChapterExtractionResult {
  const images: ChapterImageResult[] = [];

  const imgRegex = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*class=["'][^"']*(?:wp-manga-chapter-img|reading-content)[^"']*["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = imgRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    if (rawUrl && (rawUrl.includes('manhuaus') || rawUrl.includes('/manga/') || rawUrl.includes('/upload/'))) {
      images.push({
        index: index++,
        url: rawUrl.trim()
      });
    }
  }

  // Fallback broader search if class selector missed
  if (images.length === 0) {
    const fallbackRegex = /<img[^>]+(?:data-src|src)=["']([^"']+\/(?:manga|upload)\/[^"']+)["'][^>]*>/gi;
    let fbMatch: RegExpExecArray | null;
    while ((fbMatch = fallbackRegex.exec(html)) !== null) {
      images.push({
        index: index++,
        url: fbMatch[1].trim()
      });
    }
  }

  return {
    success: images.length > 0,
    domain: 'manhuaus.com',
    chapter,
    images,
    totalImages: images.length
  };
}

/**
 * Headless extraction routine for ManhuaUS (Turnstile bypass and header injection).
 */
export async function extractManhuaUS(page: any, url: string, chapter: number): Promise<ChapterExtractionResult> {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Referer': 'https://manhuaus.com/'
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });

  // Wait for Cloudflare Turnstile verification or reading content
  await page.waitForSelector('.reading-content, .entry-content', { timeout: 15000 }).catch(() => {});

  const html = await page.content();
  return parseManhuaUSHTML(html, chapter);
}
