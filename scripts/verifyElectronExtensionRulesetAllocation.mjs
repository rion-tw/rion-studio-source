import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!['darwin', 'win32'].includes(process.platform)) throw new Error('DNR allocation verification requires a native desktop host.');
const executable = createRequire(import.meta.url)('electron');
const root = await mkdtemp(join(tmpdir(), 'rion-dnr-allocation-'));
try {
  for (const phase of ['seed', 'restart']) {
    const child = spawn(executable, [fileURLToPath(new URL('./electronExtensionRulesetAllocationProbe.cjs', import.meta.url))], {
      env: { ...process.env, RION_DNR_ALLOCATION_PROBE_ROOT: root, RION_DNR_ALLOCATION_PROBE_PHASE: phase },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 && output.includes(`"phase":"${phase}"`)
        ? resolve() : reject(new Error(`Native DNR allocation ${phase} failed: ${code ?? signal}`)));
    });
  }
} finally { await rm(root, { recursive: true, force: true }); }
