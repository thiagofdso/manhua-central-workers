import puppeteer, { Browser } from 'puppeteer';

export interface PoolStats {
  activeWorkers: number;
  maxWorkers: number;
  queuedTasks: number;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private activeWorkers = 0;
  private readonly maxWorkers: number;
  private waitQueue: Array<() => void> = [];

  constructor(maxWorkers: number = 3) {
    this.maxWorkers = maxWorkers;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--mute-audio'
        ]
      });
    }
    return this.browser;
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeWorkers < this.maxWorkers) {
      this.activeWorkers++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeWorkers++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeWorkers--;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  /**
   * Executes a task with an isolated incognito browser context and page.
   */
  async withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
    await this.acquireSlot();

    let context: any = null;
    let page: any = null;

    try {
      const browser = await this.getBrowser();
      context = await browser.createBrowserContext();
      page = await context.newPage();

      // Optimize bandwidth and memory: block heavy media not needed for scraping
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        const resourceType = req.resourceType();
        if (resourceType === 'stylesheet' || resourceType === 'font' || resourceType === 'media') {
          req.abort();
        } else {
          req.continue();
        }
      });

      return await fn(page);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
      this.releaseSlot();
    }
  }

  getStats(): PoolStats {
    return {
      activeWorkers: this.activeWorkers,
      maxWorkers: this.maxWorkers,
      queuedTasks: this.waitQueue.length
    };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
