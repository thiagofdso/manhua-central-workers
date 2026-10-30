/**
 * Manhua Central — Scraping Workers Pool
 * Handles dynamic content extraction, Cloudflare Turnstile bypass and non-linear scraping.
 */
import { createScrapingServer } from './server.ts';
import { closeCoverBrowsers } from './cover-collector.ts';

const PORT = Number(process.env.PORT) || 50051;
const server = createScrapingServer();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Scraping Workers] Worker pool service listening on http://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', async () => {
  console.log('[Scraping Workers] SIGTERM received. Gracefully shutting down...');
  server.close();
  await closeCoverBrowsers();
  process.exit(0);
});
