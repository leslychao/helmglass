import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { run } from './process.mjs';

export function isInside(parent, child) {
  const tail = relative(resolve(parent), resolve(child));
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(tail));
}

export async function readProtectedFile(path, maximum = 1_048_576) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximum) {
    throw new Error('Protected input must be a bounded regular file');
  }
  return readFile(path);
}

export async function protectDirectory(path, repository) {
  if (!isAbsolute(path) || isInside(repository, path)) {
    throw new Error('Protected directory must be an absolute local path outside the repository');
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  const resolved = await realpath(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || isInside(repository, resolved)) {
    throw new Error('Protected directory must be outside the repository and must not be a link');
  }
  if (process.platform === 'win32') {
    const powershellEnvironment = { ...process.env, HELM_PROTECTED_DIRECTORY: path };
    // A launcher started in PowerShell 7 must not give Windows PowerShell incompatible modules.
    for (const name of Object.keys(powershellEnvironment)) {
      if (name.toUpperCase() === 'PSMODULEPATH') delete powershellEnvironment[name];
    }
    const identity = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress'])).stdout);
    if (!/^S-1-[0-9-]+$/.test(identity)) throw new Error('Cannot identify the current Windows account');
    // Replace, rather than augment, inherited ACLs before writing any secret.
    const aclScript = '$ErrorActionPreference="Stop";$p=$env:HELM_PROTECTED_DIRECTORY;$s=$env:HELM_OWNER_SID;'
      + '$old=Get-Acl -LiteralPath $p;$owner=$old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;'
      + 'if($owner -ne $s){throw "Directory belongs to another account"};'
      + '$a=New-Object System.Security.AccessControl.DirectorySecurity;'
      + '$a.SetAccessRuleProtection($true,$false);$id=New-Object System.Security.Principal.SecurityIdentifier($s);'
      + '$r=New-Object System.Security.AccessControl.FileSystemAccessRule($id,"FullControl","ContainerInherit,ObjectInherit","None","Allow");'
      + '$a.AddAccessRule($r);[System.IO.Directory]::SetAccessControl($p,$a)';
    // Encode fixed script text. Paths remain data in the child environment, never script syntax.
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(aclScript, 'utf16le').toString('base64')], {
      environment: { ...powershellEnvironment, HELM_OWNER_SID: identity },
    });
  } else {
    await chmod(path, 0o700);
    const verified = await lstat(path);
    if (verified.uid !== process.getuid() || (verified.mode & 0o077) !== 0) {
      throw new Error('Protected directory must be owned by the invoking account with mode 0700');
    }
  }
  return resolved;
}

export async function writeProtectedFile(path, value) {
  const metadata = await lstat(dirname(path));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid protected parent directory');
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    { mode: 0o600, flag: 'wx', flush: true });
  await synchronizeParent(path);
}

async function synchronizeParent(path) {
  // Windows FlushFileBuffers is applied above; directory fsync is supported on POSIX.
  if (process.platform === 'win32') return;
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function replaceProtectedFile(path, value, expectedDigest) {
  const current = await readProtectedFile(path);
  if (createHash('sha256').update(current).digest('hex') !== expectedDigest) {
    throw new Error('Protected file changed concurrently');
  }
  const pending = `${path}.pending`;
  await writeProtectedFile(pending, value);
  await rename(pending, path);
  await synchronizeParent(path);
}
