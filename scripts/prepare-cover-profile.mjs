import puppeteer from 'puppeteer';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

const [domain, executablePath, profilePath, validationURL] = process.argv.slice(2);
const pages = {
  'ravenscans.org': 'https://ravenscans.org/manga/?order=update',
  'manhuaus.com': 'https://manhuaus.com/manga/magic-emperor-0/'
};
if (!pages[domain] || !executablePath || !profilePath) {
  throw new Error('Usage: node scripts/prepare-cover-profile.mjs <domain> <chrome-path> <dedicated-profile-path>');
}
const validationPage = new URL(validationURL || pages[domain]);
if (validationPage.protocol !== 'https:' || validationPage.port || validationPage.hostname.replace(/^www\./, '') !== domain) throw new Error('Validation page outside source domain');
await fs.mkdir(profilePath, { recursive: true, mode: 0o700 });
const rules = [];
for (const host of [domain, 'www.' + domain, 'challenges.cloudflare.com']) {
  const addresses = await dns.resolve4(host).catch(() => []);
  if (addresses.length) rules.push('MAP ' + host + ' ' + addresses[0]);
}
const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  userDataDir: path.resolve(profilePath),
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,1000', '--host-resolver-rules=' + rules.join(', ')]
});
try {
  const expected = process.env.COVER_CHROME_VERSION || '150.0.7871.24';
  if (!(await browser.version()).includes(expected)) throw new Error('Use the same Chrome version as the cover collector: ' + expected);
  const page = await browser.newPage();
  await page.goto(validationPage.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('.thumb img,.summary_image img,.bsx img,.page-item-detail img,.c-tabs-item__content img,meta[property="og:image"]'), { timeout: 45000 });
  const source = await page.evaluate(() => {
    const img = document.querySelector('.thumb img,.summary_image img,.bsx img,.page-item-detail img,.c-tabs-item__content img');
    return img?.getAttribute('data-src') || img?.getAttribute('src') || document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  });
  const target = new URL(source, validationPage.href);
  if (target.protocol !== 'https:' || !(target.hostname === domain || target.hostname.endsWith('.' + domain))) throw new Error('Cover outside source domain');
  await page.setExtraHTTPHeaders({ Referer: 'https://' + domain + '/' });
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const type = response?.headers()['content-type'] || '';
  if (response?.status() !== 200 || !type.startsWith('image/')) throw new Error('Session did not authorize cover download');
  console.log(JSON.stringify({ domain, status: response.status(), type, bytes: (await response.buffer()).length, profile: path.resolve(profilePath) }));
} finally {
  await browser.close();
}
