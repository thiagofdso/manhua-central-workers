import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(project, '../..');
const config = path.join(os.homedir(), '.config/manhua-manager');
const profiles = path.join(os.homedir(), '.local/share/manhua-manager/collector-profiles');
const units = path.join(os.homedir(), '.config/systemd/user');
for (const dir of [config, profiles, units]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const envPath = path.join(config, 'collector.env');
const previous = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const token = previous.match(/^CATALOG_COLLECTOR_TOKEN="?([a-f0-9]{64})"?$/m)?.[1] || crypto.randomBytes(32).toString('hex');
const chrome = process.env.COVER_BROWSER_EXECUTABLE || path.join(os.homedir(), '.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome');
fs.accessSync(chrome, fs.constants.X_OK);
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const env = {
  CATALOG_COLLECTOR_TOKEN: token,
  CATALOG_COLLECTOR_BIND: '0.0.0.0',
  CATALOG_COLLECTOR_PORT: '50052',
  CATALOG_COLLECTOR_INTERVAL_MS: '3000',
  CATALOG_COLLECTOR_MANUAL_WAIT_MS: '600000',
  COVER_BROWSER_EXECUTABLE: chrome,
  COVER_BROWSER_HEADLESS: 'false',
  COVER_PROFILES_DIR: profiles,
  DISPLAY: process.env.DISPLAY || ':0',
  ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {})
};
fs.writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
// Keep a single token when rerunning the installer (EnvironmentFile values are quoted).
for (const filename of ['.env', 'deployments/.env']) {
  const target = path.join(workspace, filename);
  let composeEnv = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  for (const [key, value] of Object.entries({ CATALOG_COLLECTOR_URL: 'http://host.docker.internal:50052', CATALOG_COLLECTOR_TOKEN: token })) {
    composeEnv = composeEnv.replace(new RegExp('^' + key + '=.*\\n?', 'gm'), '');
    composeEnv += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(target, composeEnv, { mode: 0o600 });
}
const node = fs.realpathSync(process.execPath);
fs.writeFileSync(path.join(units, 'manhua-catalog-collector.service'), `[Unit]
Description=ManhuaUS and RavenScans host catalog collector
After=graphical-session.target network-online.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${project.replaceAll('%', '%%')}
EnvironmentFile=${envPath.replaceAll('%', '%%')}
ExecStart=${quote(node)} ${quote(path.join(project, 'dist/host-collector.js'))}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
`);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'manhua-catalog-collector.service'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'manhua-catalog-collector.service'], { stdio: 'inherit' });
console.log('Host collector installed. Run make run to apply the API connection.');
