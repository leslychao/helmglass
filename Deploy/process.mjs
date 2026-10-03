import { spawn } from 'node:child_process';
import { basename } from 'node:path';

/** Bounded process transport. Captured output may contain secrets and is never included in errors. */
export function run(command, arguments_, options = {}) {
  const { input, environment, cwd, timeout = 120_000, maximum = 2_097_152,
    allowedExitCodes = [0], inherit = false } = options;
  return new Promise((accept, reject) => {
    const child = spawn(command, arguments_, {
      cwd, env: environment ?? process.env, shell: false, windowsHide: true,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, timeout);
    if (!inherit) {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > maximum) { exceeded = true; child.kill(); }
      });
      child.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
        if (Buffer.byteLength(errorOutput) > maximum) { exceeded = true; child.kill(); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.once('error', () => { clearTimeout(timer); reject(new Error('Required process could not start')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (exceeded) reject(new Error('Process exceeded its time or output limit; outcome may be unknown'));
      else if (!allowedExitCodes.includes(code)) reject(new Error(`${basename(command)} failed with exit code ${code}; sensitive output withheld`));
      else accept({ code, stdout: output, stderr: errorOutput });
    });
  });
}
