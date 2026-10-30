import { createHostCollector } from './host-collector-server.ts';
import { closeCoverBrowsers } from './cover-collector.ts';

const server = createHostCollector(process.env.CATALOG_COLLECTOR_TOKEN || '');
const host = process.env.CATALOG_COLLECTOR_BIND || '127.0.0.1';
const port = Number(process.env.CATALOG_COLLECTOR_PORT || 50052);
server.requestTimeout = 180000;
server.listen(port, host, () => console.log(`[Host collector] Listening on ${host}:${port}`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await closeCoverBrowsers();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
