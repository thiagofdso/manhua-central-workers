import type { ChapterExtractionResult, ChapterImageResult } from '../types.ts';

/**
 * Pure parsing function to extract Comix images from HTML/DOM.
 */
export function parseComixHTML(html: string, chapter: number): ChapterExtractionResult {
  const images: ChapterImageResult[] = [];

  const imgRegex = /<img[^>]+(?:data-src|data-url|src)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = imgRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    if (rawUrl && (rawUrl.includes('comix') || rawUrl.includes('/chapters/') || rawUrl.includes('cdn') || rawUrl.includes('/pages/'))) {
      images.push({
        index: index++,
        url: rawUrl.trim()
      });
    }
  }

  return {
    success: images.length > 0,
    domain: 'comix.to',
    chapter,
    images,
    totalImages: images.length
  };
}

/**
 * Headless extraction routine for Comix (strips Referer header).
 */
export async function extractComix(page: any, url: string, chapter: number): Promise<ChapterExtractionResult> {
  // Comix rule: Do NOT send Referer header
  await page.setExtraHTTPHeaders({});

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.reading-content, #reader, img', { timeout: 10000 }).catch(() => {});

  const html = await page.content();
  return parseComixHTML(html, chapter);
}
