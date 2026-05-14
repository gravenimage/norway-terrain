import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 45000;

export async function startViewerServer({ port = 8765, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const child = spawn('uv', ['run', 'serve.py', '--no-browser', '--port', String(port)], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const cleanup = () => {
    if (process.platform === 'win32' && child.pid) {
      killWindowsProcessTree(child.pid);
      return;
    }

    if (!child.killed) {
      child.kill();
    }
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for serve.py. stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/viewer:\s+(http:\/\/localhost:\d+\/viewer\.html)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`serve.py exited before ready with code ${code}. stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });

  const viewerUrl = await ready;

  return {
    viewerUrl,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      cleanup();
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    },
  };
}

function killWindowsProcessTree(pid) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$root = ${pid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]
function Add-Children([int]$parent) {
  foreach ($proc in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
    Add-Children ([int]$proc.ProcessId)
    $ids.Add([int]$proc.ProcessId)
  }
}
Add-Children $root
$ids.Add($root)
foreach ($id in $ids | Select-Object -Unique) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
`;

  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}
