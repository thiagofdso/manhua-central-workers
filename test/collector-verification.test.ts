import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { collectCatalog, closeCoverBrowsers } from '../src/cover-collector.ts';

test('manual verification keeps one tab and releases the queue for other pages', async () => {
  const launch = puppeteer.launch;
  const manualWait = process.env.CATALOG_COLLECTOR_MANUAL_WAIT_MS;
  const profileDir = process.env.COVER_PROFILES_DIR;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-verification-'));
  process.env.COVER_PROFILES_DIR = temp;
  process.env.CATALOG_COLLECTOR_MANUAL_WAIT_MS = '1';
  const pages: { blocked: boolean; closed: boolean }[] = [];
  const navigations: string[] = [];
  let started!: () => void;
  const activeStarted = new Promise<void>(resolve => { started = resolve; });
  const fake = {
    connected: true,
    version: async () => 'Chrome/test',
    userAgent: async () => 'Chrome/test',
    close: async () => {},
    newPage: async () => {
      const state = { blocked: false, closed: false };
      let releaseNavigation: (() => void) | undefined;
      pages.push(state);
      return {
        setUserAgent: async () => {},
        goto: async (url: string) => {
          navigations.push(url);
          state.blocked = /page=(85|115)&/.test(url);
          if (url.includes('page=117&')) {
            await new Promise<void>(resolve => { releaseNavigation = resolve; started(); });
          }
          return { status: () => state.blocked ? 403 : 200 };
        },
        title: async () => state.blocked ? 'Just a moment...' : 'Manga',
        isClosed: () => state.closed,
        close: async () => { state.closed = true; releaseNavigation?.(); },
        waitForSelector: async () => {},
        evaluate: async () => ({ items: [], page: 114, totalPages: 137 }),
      };
    },
  };
  puppeteer.launch = async () => fake as unknown as Browser;
  try {
    const blocked = collectCatalog('ravenscans.org', '', 85);
    const expired = new AbortController();
    const expiredCheck = assert.rejects(collectCatalog('ravenscans.org', '', 116, expired.signal));
    expired.abort();
    const next = collectCatalog('ravenscans.org', '', 114);
    await assert.rejects(blocked, /Source requires manual verification/);
    assert.equal((await next).page, 114);
    await expiredCheck;
    assert.equal(navigations.some(url => url.includes('page=116&')), false, 'expired queued requests must not navigate');
    assert.equal(pages[0].closed, false, 'operator validation tab must remain open');
    await assert.rejects(collectCatalog('ravenscans.org', '', 115), /manual verification/);
    assert.equal(pages.length, 2, 'reuse the working tab alongside one validation tab');
    await collectCatalog('ravenscans.org', '', 114);
    assert.equal(pages.length, 2, 'successful tasks must reuse the same tab');
    const active = new AbortController();
    const cancelledCheck = assert.rejects(collectCatalog('ravenscans.org', '', 117, active.signal));
    await activeStarted;
    active.abort();
    await cancelledCheck;
    assert.equal(pages[1].closed, true, 'disconnected active request must stop its navigation');
    assert.equal(pages[0].closed, false, 'cancellation must preserve operator validation');
    await collectCatalog('ravenscans.org', '', 114);
    assert.equal(pages.length, 3, 'replace only the cancelled working tab');
  } finally {
    await closeCoverBrowsers();
    puppeteer.launch = launch;
    if (manualWait === undefined) delete process.env.CATALOG_COLLECTOR_MANUAL_WAIT_MS;
    else process.env.CATALOG_COLLECTOR_MANUAL_WAIT_MS = manualWait;
    if (profileDir === undefined) delete process.env.COVER_PROFILES_DIR;
    else process.env.COVER_PROFILES_DIR = profileDir;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
