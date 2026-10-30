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
 * Headless extraction routine for Comix (strips Referer header, handles dynamic React Fiber query cache).
 */
export async function extractComix(page: any, url: string, chapter: number): Promise<ChapterExtractionResult> {
  // Comix rule: Do NOT send Referer header (ADR-0002)
  await page.setExtraHTTPHeaders({});
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  let chapterUrl = url;

  // Resolve chapter URL from title page if needed
  const chMatch = url.match(/\/(\d+)-chapter-(\d+)/);
  if (!chMatch) {
    const slugMatch = url.match(/\/title\/([^/?#]+)/);
    if (slugMatch) {
      const titleUrl = `https://comix.to/title/${slugMatch[1]}`;
      await page.goto(titleUrl, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));

      const resolvedUrl = await page.evaluate((targetNum: number) => {
        const links = Array.from(document.querySelectorAll('a[href*="-chapter-"]')) as HTMLAnchorElement[];
        if (targetNum) {
          const exact = links.find(a =>
            a.href.includes(`-chapter-${targetNum}`) ||
            (a.textContent && a.textContent.trim().toLowerCase().startsWith(`ch.${targetNum}`))
          );
          if (exact) return exact.href;
        }
        return links.length > 0 ? links[0].href : null;
      }, chapter);

      if (resolvedUrl) {
        chapterUrl = resolvedUrl;
      }
    }
  }

  await page.goto(chapterUrl, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  // Extract from TanStack Query Cache on React Fiber
  const chapterData: any = await page.evaluate(() => {
    const root = document.querySelector('#app') || document.querySelector('#__next') || document.querySelector('body > div');
    for (const k in root) {
      if (k.startsWith('__reactFiber') || k.startsWith('__reactContainer')) {
        let queue = [(root as any)[k]];
        while (queue.length > 0) {
          const cur = queue.shift();
          if (cur?.memoizedProps?.client?.getQueryCache) {
            const queries = cur.memoizedProps.client.getQueryCache().getAll();
            const q = queries.find((query: any) =>
              query.queryKey?.some?.((key: any) => typeof key === 'string' && key.includes('chapters'))
            );
            if (q?.state?.data) return q.state.data;
          }
          if (cur?.child) queue.push(cur.child);
          if (cur?.sibling) queue.push(cur.sibling);
        }
      }
    }
    return null;
  });

  if (chapterData) {
    let rawPages: any[] = [];
    for (const val of Object.values(chapterData)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        if (val[0]?.D_ || val[0]?.zr || val[0]?.url || val[0]?.src) {
          rawPages = val;
          break;
        }
      }
    }

    if (rawPages.length > 0) {
      const images: ChapterImageResult[] = [];
      for (let i = 0; i < rawPages.length; i++) {
        const p = rawPages[i];
        const imgUrl = p?.D_ || p?.zr || p?.url || p?.src;
        if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
          images.push({
            index: i + 1,
            url: imgUrl.trim()
          });
        }
      }

      if (images.length > 0) {
        return {
          success: true,
          domain: 'comix.to',
          chapter,
          images,
          totalImages: images.length
        };
      }
    }
  }

  // Fallback to DOM parsing
  const html = await page.content();
  return parseComixHTML(html, chapter);
}
