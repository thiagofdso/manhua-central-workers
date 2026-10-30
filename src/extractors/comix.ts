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

      let resolvedUrl: string | null = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        resolvedUrl = await page.evaluate((targetNum: number) => {
          const links = Array.from(document.querySelectorAll('a[href*="-chapter-"]')) as HTMLAnchorElement[];
          if (targetNum) {
            const hrefRe = new RegExp(`-chapter-${targetNum}($|[/?#])`);
            const textRe = new RegExp(`^\\s*Ch\\.${targetNum}(\\b|\\s|$)`, 'i');
            const exact = links.find(a => hrefRe.test(a.href) || textRe.test((a.textContent || '').trim()));
            if (exact) return exact.href;
          }
          return null;
        }, chapter);

        if (resolvedUrl) break;

        // Paginate to next batch of chapters if not found on current page
        const hasNext = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('.npager__num')) as HTMLElement[];
          if (btns.length > 0) {
            btns[btns.length - 1].click();
            return true;
          }
          const navBtn = document.querySelector('.npager__nav:last-child') as HTMLElement;
          if (navBtn) {
            navBtn.click();
            return true;
          }
          return false;
        });

        if (!hasNext) break;
        await new Promise(r => setTimeout(r, 1200));
      }

      if (resolvedUrl) {
        chapterUrl = resolvedUrl;
      } else {
        // Fallback to first chapter link if exact chapter link was not found
        const firstLink = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="-chapter-"]')) as HTMLAnchorElement[];
          return links.length > 0 ? links[0].href : null;
        });
        if (firstLink) {
          chapterUrl = firstLink;
        }
      }
    }
  }

  await page.goto(chapterUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});

  // Wait for TanStack Query Cache on React Fiber to populate chapter data
  let chapterData: any = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    chapterData = await page.evaluate(() => {
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
      let found = false;
      for (const val of Object.values(chapterData)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
          for (const v of Object.values(val[0])) {
            if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  if (chapterData) {
    let rawPages: any[] = [];
    let imageKey = '';

    for (const val of Object.values(chapterData)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        for (const [k, v] of Object.entries(val[0])) {
          if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
            rawPages = val;
            imageKey = k;
            break;
          }
        }
        if (rawPages.length > 0) break;
      }
    }

    if (rawPages.length > 0 && imageKey) {
      const images: ChapterImageResult[] = [];
      for (let i = 0; i < rawPages.length; i++) {
        const p = rawPages[i];
        const imgUrl = p?.[imageKey];
        if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
          images.push({
            index: i + 1,
            url: imgUrl.trim()
          });
        }
      }

      // Also extract navigation if present
      let nextChapterUrl: string | undefined;
      let prevChapterUrl: string | undefined;

      for (const val of Object.values(chapterData)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const obj = val as Record<string, any>;
          for (const v of Object.values(obj)) {
            if (typeof v === 'string' && v.includes('/title/') && v.includes('-chapter-')) {
              const fullUrl = v.startsWith('http') ? v : `https://comix.to${v}`;
              if (obj.B1 && obj.B1 > chapter) {
                nextChapterUrl = fullUrl;
              } else if (obj.B1 && obj.B1 < chapter) {
                prevChapterUrl = fullUrl;
              }
            }
          }
        }
      }

      if (images.length > 0) {
        return {
          success: true,
          domain: 'comix.to',
          chapter,
          images,
          totalImages: images.length,
          nextChapter: nextChapterUrl,
          prevChapter: prevChapterUrl
        };
      }
    }
  }

  // Fallback to DOM parsing
  const html = await page.content();
  return parseComixHTML(html, chapter);
}
