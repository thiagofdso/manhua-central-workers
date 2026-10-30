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

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});

  // Wait for Cloudflare challenge if present
  for (let i = 0; i < 30; i++) {
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

  // Wait for reading-content or page break images
  await page.waitForSelector('.reading-content img, .wp-manga-chapter-img', { timeout: 15000 }).catch(() => {});

  const extracted = await page.evaluate(() => {
    const imgEls = Array.from(document.querySelectorAll('.reading-content img, .wp-manga-chapter-img')) as HTMLImageElement[];
    return imgEls
      .map(img => (img.getAttribute('data-src') || img.src || '').trim())
      .filter(src => Boolean(src) && !src.startsWith('data:') && !src.includes('logo') && !src.includes('avatar'));
  });

  if (extracted && extracted.length > 0) {
    const unique = Array.from(new Set(extracted as string[]));
    return {
      success: true,
      domain: 'manhuaus.com',
      chapter,
      images: unique.map((u, idx) => ({ index: idx + 1, url: u })),
      totalImages: unique.length
    };
  }

  const html = await page.content();
  return parseManhuaUSHTML(html, chapter);
}
