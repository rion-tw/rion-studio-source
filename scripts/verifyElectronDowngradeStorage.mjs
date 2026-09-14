import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const previous = process.env.RION_DOWNGRADE_PREVIOUS_ELECTRON;
if (!previous) throw new Error('RION_DOWNGRADE_PREVIOUS_ELECTRON must identify Electron 44.3.0');
const directory = await mkdtemp(join(tmpdir(), 'rion-downgrade-proof-'));
const extension = join(directory, 'extension');
const server = createServer((_request, response) => response.end('<title>Storage fixture</title>'));
await new Promise((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
try {
  await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Storage compatibility fixture', version: '1.0',
    permissions: ['storage']
  }));
  await writeFile(join(extension, 'probe.html'), '<title>Extension storage fixture</title>');
  for (const [phase, executable] of [['seed', previous], ['verify', require('electron')]]) {
    await new Promise((resolveExit, reject) => {
      const child = spawn(executable, [resolve('scripts/electronDowngradeStorageProbe.cjs')], {
        env: { ...process.env, RION_DOWNGRADE_PHASE: phase,
          RION_DOWNGRADE_USER_DATA: join(directory, 'user-data'),
          RION_DOWNGRADE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
          RION_DOWNGRADE_EXTENSION: extension },
        stdio: 'inherit'
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolveExit()
        : reject(new Error(`${phase} failed: ${code ?? signal}`)));
    });
  }
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}
