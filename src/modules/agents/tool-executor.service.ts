import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  workingDirectory: string;
  jobId: string;
  onLog?: (message: string) => void;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

// Keys that subprocess tools legitimately need. Everything else
// (JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, *_API_KEY, etc.) is stripped.
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'NVM_DIR', 'NVM_BIN', 'GOPATH', 'GOROOT',
  'CARGO_HOME', 'RUSTUP_HOME',
  'JAVA_HOME', 'ANDROID_HOME',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
];

function subprocessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true' };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  async execute(
    toolName: string,
    args: Record<string, any>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const log = ctx.onLog ?? ((m: string) => this.logger.debug(`[${ctx.jobId}] ${m}`));

    try {
      switch (toolName) {
        case 'read_file': {
          const readPath = args.path ?? args.filename ?? args.file_path ?? args.filepath ?? args.name;
          return await this.readFile(readPath, ctx.workingDirectory);
        }

        case 'write_file': {
          const filePath =
            args.path ?? args.filename ?? args.file_path ?? args.filepath ?? args.name ??
            Object.entries(args).find(([k, v]) => k !== 'content' && typeof v === 'string' && v.length < 500)?.[1] as string | undefined;
          if (!filePath) {
            const keys = Object.keys(args).join(', ');
            return { success: false, output: '', error: `write_file: could not determine path from args. Keys present: [${keys}]` };
          }
          return await this.writeFile(filePath, args.content, ctx.workingDirectory, log);
        }

        case 'delete_file':
          return await this.deleteFile(args.path, ctx.workingDirectory, log);

        case 'list_directory':
          return await this.listDirectory(args.path ?? '.', ctx.workingDirectory, args.recursive, args.maxDepth);

        case 'search_codebase':
          return await this.searchCodebase(args.pattern, args.path, args.filePattern, args.caseSensitive, ctx.workingDirectory);

        case 'run_command':
          return await this.runCommand(args.command, args.workingDir, ctx.workingDirectory, args.timeout ?? 120, log);

        case 'run_tests':
          return await this.runTests(args.testPath, args.flags, ctx.workingDirectory, log);

        case 'get_git_diff':
          return await this.getGitDiff(args.staged, args.path, ctx.workingDirectory);

        case 'git_status':
          return await this.gitStatus(ctx.workingDirectory);

        case 'inspect_package':
          return await this.inspectPackage(args.packageFile, ctx.workingDirectory);

        default:
          return { success: false, output: '', error: `Unknown tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private resolveSafePath(relativePath: string, workDir: string): string {
    if (path.isAbsolute(relativePath) && relativePath.startsWith(workDir)) {
      relativePath = path.relative(workDir, relativePath);
    }
    const resolved = path.resolve(workDir, relativePath);
    if (!resolved.startsWith(workDir)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return resolved;
  }

  private async readFile(filePath: string, workDir: string): Promise<ToolResult> {
    const fullPath = this.resolveSafePath(filePath, workDir);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n').length;
      if (content.length > 100_000) {
        return {
          success: true,
          output: content.slice(0, 100_000) + `\n\n[... truncated, ${content.length} total chars, ${lines} lines ...]`,
        };
      }
      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: '', error: `Cannot read file: ${err.message}` };
    }
  }

  private async writeFile(filePath: string, content: string, workDir: string, log: (m: string) => void): Promise<ToolResult> {
    const fullPath = this.resolveSafePath(filePath, workDir);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    log(`Wrote ${content.split('\n').length} lines to ${filePath}`);
    return { success: true, output: `File written: ${filePath}` };
  }

  private async deleteFile(filePath: string, workDir: string, log: (m: string) => void): Promise<ToolResult> {
    const fullPath = this.resolveSafePath(filePath, workDir);
    await fs.unlink(fullPath);
    log(`Deleted file: ${filePath}`);
    return { success: true, output: `File deleted: ${filePath}` };
  }

  private async listDirectory(dirPath: string, workDir: string, recursive?: boolean, maxDepth?: number): Promise<ToolResult> {
    const fullPath = this.resolveSafePath(dirPath, workDir);

    const list = async (dir: string, depth: number): Promise<string[]> => {
      if (maxDepth !== undefined && depth > maxDepth) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: string[] = [];

      for (const entry of entries) {
        if (['.git', 'node_modules', '.next', '__pycache__', 'dist', 'build', 'target'].includes(entry.name)) {
          continue;
        }
        const rel = path.relative(workDir, path.join(dir, entry.name));
        results.push(entry.isDirectory() ? `${rel}/` : rel);
        if (recursive && entry.isDirectory()) {
          results.push(...(await list(path.join(dir, entry.name), depth + 1)));
        }
      }
      return results;
    };

    const files = await list(fullPath, 0);
    return { success: true, output: files.join('\n') };
  }

  private async searchCodebase(
    pattern: string,
    searchPath: string | undefined,
    filePattern: string | undefined,
    caseSensitive: boolean | undefined,
    workDir: string,
  ): Promise<ToolResult> {
    const dir = searchPath ? this.resolveSafePath(searchPath, workDir) : workDir;

    // Build args array — no shell interpolation, no injection risk
    const args = ['-rn', '--exclude-dir=node_modules', '--exclude-dir=.git',
                  '--exclude-dir=dist', '--exclude-dir=.next', '-m', '100'];
    if (!caseSensitive) args.push('-i');
    if (filePattern) args.push(`--include=${filePattern}`);
    args.push(pattern, dir);

    try {
      const { stdout } = await execFileAsync('grep', args, {
        timeout: 15000,
        cwd: workDir,
        env: subprocessEnv(),
        maxBuffer: 2 * 1024 * 1024,
      });
      const truncated = stdout.split('\n').slice(0, 200).join('\n');
      return { success: true, output: truncated || '(no matches)' };
    } catch (err: any) {
      if (err.code === 1) return { success: true, output: '(no matches)' };
      return { success: false, output: '', error: err.message };
    }
  }

  private async runCommand(
    command: string,
    relativeCwd: string | undefined,
    workDir: string,
    timeout: number,
    log: (m: string) => void,
  ): Promise<ToolResult> {
    const cwd = relativeCwd ? this.resolveSafePath(relativeCwd, workDir) : workDir;
    const safeTimeout = Math.min(timeout, 900) * 1000;   // 15 min cap (Rust/JVM compile)

    // Block the most obviously destructive patterns
    const blocked = [
      'rm -rf /', 'dd if=', ':(){ :|:& };:', 'mkfs', 'mkfs.', '/dev/sd', '/dev/hd', '/dev/nvme',
      'curl ', 'wget ', 'nc ', 'netcat', 'ncat', 'socat',   // block outbound network
      'cargo fetch', 'cargo update', 'cargo add', 'npm install', 'npm ci', 'pip install', 'pip3 install', 'go get', 'go mod download',  // block package downloads
    ];
    if (blocked.some((b) => command.includes(b))) {
      return { success: false, output: '', error: 'Command blocked for safety' };
    }

    log(`Running: ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: safeTimeout,
        // Stripped env — secrets are NOT inherited
        env: subprocessEnv(),
        maxBuffer: 10 * 1024 * 1024,
      });
      return { success: true, output: (stdout + stderr).trim() };
    } catch (err: any) {
      return {
        success: false,
        output: (err.stdout ?? '') + (err.stderr ?? ''),
        error: `Exit code ${err.code}: ${err.message}`,
      };
    }
  }

  private async runTests(
    testPath: string | undefined,
    flags: string | undefined,
    workDir: string,
    log: (m: string) => void,
  ): Promise<ToolResult> {
    let command = '';
    let timeout = 120;

    // Node / npm
    try {
      const pkgJson = JSON.parse(await fs.readFile(path.join(workDir, 'package.json'), 'utf-8'));
      if (pkgJson.scripts?.test) {
        command = `npm test ${testPath ? `-- ${testPath}` : ''} ${flags ?? ''} -- --forceExit 2>&1`;
      }
    } catch { /* not Node */ }

    // Rust / Cargo
    if (!command) {
      try {
        await fs.access(path.join(workDir, 'Cargo.toml'));
        const testTarget = testPath ? `${testPath}` : '';
        command = `cargo test ${testTarget} ${flags ?? ''} 2>&1`;
        timeout = 900;   // Rust needs up to 15 min to compile + test
      } catch { /* not Rust */ }
    }

    // Python / pytest
    if (!command) {
      try {
        await execFileAsync('python3', ['-m', 'pytest', '--version'], {
          cwd: workDir, timeout: 5000, env: subprocessEnv(),
        });
        command = `python3 -m pytest ${testPath ?? ''} ${flags ?? ''} -v 2>&1`;
        timeout = 180;
      } catch { /* not Python */ }
    }

    // Go
    if (!command) {
      try {
        await fs.access(path.join(workDir, 'go.mod'));
        command = `go test ${testPath ?? './...'} ${flags ?? ''} 2>&1`;
        timeout = 180;
      } catch {
        return { success: false, output: '', error: 'Could not detect test runner' };
      }
    }

    return this.runCommand(command, undefined, workDir, timeout, log);
  }

  private async getGitDiff(staged: boolean | undefined, filePath: string | undefined, workDir: string): Promise<ToolResult> {
    // Fixed args — no user input interpolated into shell
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (filePath) { args.push('--'); args.push(this.resolveSafePath(filePath, workDir)); }

    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: workDir,
        timeout: 10000,
        env: subprocessEnv(),
        maxBuffer: 2 * 1024 * 1024,
      });
      const truncated = stdout.split('\n').slice(0, 1000).join('\n');
      return { success: true, output: truncated || '(no changes)' };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private async gitStatus(workDir: string): Promise<ToolResult> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], {
        cwd: workDir,
        timeout: 5000,
        env: subprocessEnv(),
      });
      return { success: true, output: stdout || '(clean working tree)' };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private async inspectPackage(packageFile: string | undefined, workDir: string): Promise<ToolResult> {
    const candidates = packageFile
      ? [packageFile]
      : ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile'];

    const results: string[] = [];
    for (const file of candidates) {
      try {
        const fullPath = this.resolveSafePath(file, workDir);
        const content = await fs.readFile(fullPath, 'utf-8');
        results.push(`=== ${file} ===\n${content.slice(0, 5000)}`);
      } catch { /* Skip missing files */ }
    }

    if (!results.length) return { success: false, output: '', error: 'No package/dependency files found' };
    return { success: true, output: results.join('\n\n') };
  }
}
