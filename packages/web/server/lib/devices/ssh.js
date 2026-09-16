import { asFiniteNumber, asNonEmptyString } from './parse.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const fail = (message, code, statusCode = 502) =>
  Object.assign(new Error(message), { code, statusCode });

/**
 * SSH operations against a registered Windows device.
 * Uses the system OpenSSH client so the container/runtime needs no native addon.
 */
export const createDeviceSshClient = ({ spawn, os, path, fsPromises, readPrivateKey }) => {
  const runWindowsCommand = (file, args) => new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });

  /**
   * Windows OpenSSH refuses a key whose ACL is readable by other users.
   * `%TEMP%` inherits broad ACLs. Protect inheritance and grant Read only to
   * the account this process runs as (PowerShell Set-Acl; icacls with
   * USERDOMAIN\USERNAME is unreliable with non-ASCII host names).
   */
  const tightenWindowsKeyAcl = async (keyPath) => {
    if (process.platform !== 'win32') return;
    const escaped = keyPath.replace(/'/g, "''");
    const script = [
      `$p='${escaped}'`,
      `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name`,
      `$a=Get-Acl -LiteralPath $p`,
      `$a.SetAccessRuleProtection($true,$false)`,
      `$r=New-Object System.Security.AccessControl.FileSystemAccessRule($u,'Read','Allow')`,
      `$a.SetAccessRule($r)`,
      `Set-Acl -LiteralPath $p -AclObject $a`,
    ].join('; ');
    await runWindowsCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ]);
  };

  const withTempKey = async (privateKey, fn) => {
    if (!privateKey) return fn(null);
    // Bun's default `os` export has no `promises`; use fsPromises for mkdtemp.
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-device-ssh-'));
    const keyPath = path.join(dir, 'id');
    try {
      await fsPromises.writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
        mode: 0o600,
      });
      await tightenWindowsKeyAcl(keyPath);
      return await fn(keyPath);
    } finally {
      try {
        await fsPromises.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };

  const runSsh = ({ ssh, user, keyPath, remoteCommand, timeoutMs }) => new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      // Own-device fleet over Tailscale/tunnel: skip host-key pinning for M1.
      // Prefer known_hosts management before wider deployment.
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=8',
      '-o', 'LogLevel=ERROR',
      '-p', String(ssh.port || 22),
    ];
    if (keyPath) args.push('-i', keyPath);
    args.push(`${user}@${ssh.host}`, remoteCommand);

    const child = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\nssh timed out after ${timeoutMs}ms`.trim(),
        code: 'timeout',
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: error.message,
        code: 'spawn_failed',
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        code: code === 0 ? null : 'ssh_failed',
      });
    });
  });

  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

  const exec = async ({ device, transport, command, cwd, timeoutMs }) => {
    if (!transport.ssh) throw fail('Device SSH transport is unavailable', 'transport_unavailable');
    const commandText = asNonEmptyString(command);
    if (!commandText) {
      throw fail('command is required', 'invalid_input', 400);
    }
    const privateKey = device.auth.sshKeyRef ? await readPrivateKey(device.id) : null;
    const cwdText = asNonEmptyString(cwd);
    const remote = cwdText
      ? `cd ${shellQuote(cwdText)} && ${commandText}`
      : commandText;
    return withTempKey(privateKey, async (keyPath) => {
      const result = await runSsh({
        ssh: transport.ssh,
        user: device.auth.sshUser,
        keyPath,
        remoteCommand: remote,
        timeoutMs: asFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS),
      });
      if (!result.ok && result.code === 'transport_unavailable') throw result;
      const payload = {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
      };
      const code = asNonEmptyString(result.code);
      if (code) payload.error = code;
      return payload;
    });
  };

  const list = async ({ device, transport, remotePath, timeoutMs }) => {
    const pathValue = asNonEmptyString(remotePath) || '.';
    const escaped = pathValue.replace(/'/g, "''");
    return exec({
      device,
      transport,
      command: `powershell -NoProfile -Command "Get-ChildItem -Force -LiteralPath '${escaped}' | Select-Object Mode,Length,LastWriteTime,Name | ConvertTo-Json -Compress"`,
      timeoutMs: asFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS),
    });
  };

  const read = async ({ device, transport, remotePath, encoding = 'utf8', timeoutMs }) => {
    const pathText = asNonEmptyString(remotePath);
    if (!pathText) {
      throw fail('path is required', 'invalid_input', 400);
    }
    const escaped = pathText.replace(/'/g, "''");
    const encodingMode = encoding === 'base64' ? 'base64' : 'utf8';
    return exec({
      device,
      transport,
      command: `powershell -NoProfile -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('${escaped}'))"`,
      timeoutMs: asFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS),
    }).then((result) => {
      if (!result.ok) return result;
      const base64 = result.stdout.trim();
      let text;
      try {
        const buffer = Buffer.from(base64, 'base64');
        text = encodingMode === 'base64' ? base64 : buffer.toString('utf8');
      } catch {
        return { ok: false, exitCode: 1, stdout: '', stderr: 'Failed to decode remote file', error: 'decode_failed' };
      }
      return {
        ok: true,
        exitCode: 0,
        content: text,
        encoding: encodingMode,
        truncated: base64.length > MAX_OUTPUT_BYTES,
      };
    });
  };

  const write = async ({ device, transport, remotePath, content, overwrite = true, timeoutMs }) => {
    const pathText = asNonEmptyString(remotePath);
    if (!pathText) {
      throw fail('path is required', 'invalid_input', 400);
    }
    if (content === null || content === undefined) {
      throw fail('content must be a string', 'invalid_input', 400);
    }
    const contentText = String(content);
    const escaped = pathText.replace(/'/g, "''");
    const base64 = Buffer.from(contentText, 'utf8').toString('base64');
    const existsCheck = overwrite
      ? `$null`
      : `if (Test-Path -LiteralPath '${escaped}') { throw 'exists' }`;
    const command = `powershell -NoProfile -Command "${existsCheck}; $b=[Convert]::FromBase64String('${base64}'); [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName('${escaped}')) | Out-Null; [IO.File]::WriteAllBytes('${escaped}', $b)"`;
    return exec({ device, transport, command, timeoutMs: asFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS) });
  };

  return { exec, list, read, write, DEFAULT_TIMEOUT_MS };
};
