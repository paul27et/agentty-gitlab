// GitLab through `glab api`, so the plugin never sees a token, and the git repository of a folder.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const EXE = process.platform === 'win32' ? 'glab.exe' : 'glab';
// Agentty starts plugins with the login shell's PATH, but a GUI app may still miss Homebrew.
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(homedir(), '.local', 'bin'), '/usr/bin'];
const MAX_PAGES = 20;

/** Hosts that are never GitLab, so a repository there is not looked up at all. */
const NOT_GITLAB = new Set(['github.com', 'bitbucket.org', 'codeberg.org', 'gitee.com', 'dev.azure.com', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com']);

export class GlabError extends Error {
  /** kind: missing | auth | api | timeout */
  constructor(message, kind = 'api', status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

let glabPath;

export async function findGlab() {
  if (glabPath) return glabPath;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...KNOWN_DIRS];
  for (const dir of dirs) {
    try {
      await access(join(dir, EXE), constants.X_OK);
      return (glabPath = join(dir, EXE));
    } catch {
      // not here
    }
  }
  return null;
}

function run(file, args, { cwd, timeout = 20000, maxBuffer = 8 << 20, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, timeout, maxBuffer, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', GLAB_CHECK_UPDATE: 'false' } },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin.end(input ?? '');
  });
}

/** `glab: 404 Project Not Found (HTTP 404)`, or an ERROR box ending in `Unauthenticated.` → a GlabError. */
function glabFailure(err, host) {
  if (err.code === 'ENOENT') return new GlabError('glab is not installed.', 'missing');
  if (err.killed) return new GlabError(`GitLab at ${host} did not answer in time.`, 'timeout');
  const lines = String(err.stderr || err.message).split('\n').map((l) => l.trim()).filter(Boolean);
  const message = (lines.at(-1) ?? 'glab failed').replace(/^glab:\s*/, '');
  const status = Number(message.match(/\(HTTP (\d{3})\)/)?.[1]) || undefined;
  if (status === 401 || /unauthenticated|not authenticated|no token|glab auth login/i.test(lines.join(' '))) {
    return new GlabError(`glab is not signed in to ${host}.`, 'auth', status);
  }
  return new GlabError(message, 'api', status);
}

export class GitLab {
  constructor(host) {
    this.host = host;
    this.projects = new Map();
    this.me = null;
  }

  /** GET by default; `raw` returns the body as text. */
  async api(endpoint, { method, raw = false, maxBuffer } = {}) {
    const glab = await findGlab();
    if (!glab) throw new GlabError('glab is not installed.', 'missing');
    const args = ['api', '--hostname', this.host];
    if (method) args.push('--method', method);
    args.push(endpoint);
    let out;
    try {
      out = await run(glab, args, { maxBuffer, cwd: homedir() });
    } catch (err) {
      throw glabFailure(err, this.host);
    }
    if (raw) return out;
    return out.trim() ? JSON.parse(out) : null;
  }

  /** Every page of a list. Not `glab api --paginate`: it prints one array per page, which is not JSON. */
  async all(endpoint, perPage = 100) {
    const items = [];
    const sep = endpoint.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.api(`${endpoint}${sep}per_page=${perPage}&page=${page}`);
      items.push(...batch);
      if (batch.length < perPage) break;
    }
    return items;
  }

  async user() {
    this.me ??= await this.api('user');
    return this.me;
  }

  async project(path) {
    if (!this.projects.has(path)) this.projects.set(path, await this.api(`projects/${encodeURIComponent(path)}`));
    return this.projects.get(path);
  }

  /** The branch's open MR, or else its latest one, from this project (not a fork); with `head_pipeline`. */
  async branchMr(projectId, branch) {
    const ref = encodeURIComponent(branch);
    const own = (mrs) => mrs.find((mr) => mr.source_project_id === projectId);
    const mr =
      own(await this.api(`projects/${projectId}/merge_requests?source_branch=${ref}&state=opened&per_page=20`)) ??
      own(await this.api(`projects/${projectId}/merge_requests?source_branch=${ref}&state=all&order_by=updated_at&per_page=20`));
    return mr ? this.api(`projects/${projectId}/merge_requests/${mr.iid}`) : null;
  }

  async latestPipeline(projectId, branch) {
    const [pipeline] = await this.api(`projects/${projectId}/pipelines?ref=${encodeURIComponent(branch)}&order_by=id&sort=desc&per_page=1`);
    return pipeline ?? null;
  }

  /** Jobs and trigger jobs (bridges) of a pipeline, in the order they were created. */
  async pipelineJobs(projectId, pipelineId) {
    const [jobs, bridges] = await Promise.all([
      this.all(`projects/${projectId}/pipelines/${pipelineId}/jobs`),
      this.all(`projects/${projectId}/pipelines/${pipelineId}/bridges`),
    ]);
    // Pages are newest first, so a retry between two page requests can list a job twice.
    const byId = new Map([...jobs, ...bridges.map((b) => ({ ...b, bridge: true }))].map((j) => [j.id, j]));
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  discussions(projectId, iid) {
    return this.all(`projects/${projectId}/merge_requests/${iid}/discussions`);
  }

  trace(projectId, jobId) {
    return this.api(`projects/${projectId}/jobs/${jobId}/trace`, { raw: true, maxBuffer: 64 << 20 });
  }

  retryJob(projectId, jobId) {
    return this.api(`projects/${projectId}/jobs/${jobId}/retry`, { method: 'POST' });
  }

  /** Retries every failed or canceled job of the pipeline, trigger jobs and allowed failures included. */
  retryPipeline(projectId, pipelineId) {
    return this.api(`projects/${projectId}/pipelines/${pipelineId}/retry`, { method: 'POST' });
  }

  /** Open MRs where the user is a reviewer, and the ones they wrote: the 50 updated last of each. */
  async myMrs() {
    const me = await this.user();
    const [review, authored] = await Promise.all([
      this.api(`merge_requests?reviewer_id=${me.id}&scope=all&state=opened&order_by=updated_at&per_page=50`),
      this.api('merge_requests?scope=created_by_me&state=opened&order_by=updated_at&per_page=50'),
    ]);
    return { review, authored };
  }
}

// ---------------------------------------------------------------- git

/** `git@host:group/repo.git`, `ssh://git@host:2222/group/repo.git`, `https://host:8443/group/repo` → { host, path } */
export function parseRemote(url) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  const scp = text.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return clean(scp[1], scp[2]);
  try {
    const u = new URL(text);
    // An http(s) port is where the API is; an ssh port is not.
    if (['http:', 'https:'].includes(u.protocol)) return clean(u.host, u.pathname);
    if (['ssh:', 'git+ssh:'].includes(u.protocol)) return clean(u.hostname, u.pathname);
    return null;
  } catch {
    return null;
  }
}

/** A plain host name, optionally with a port: hosts end up in a command line (`glab auth login --hostname …`). */
export const isHost = (host) => typeof host === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(host);

function clean(host, path) {
  const p = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!isHost(host) || !p.includes('/')) return null;
  return { host: host.toLowerCase(), path: p };
}

/** The repository of a folder: { root, branch, remote, host, path }, or null outside one. host is null off GitLab. */
export async function detectRepo(cwd) {
  if (!cwd) return null;
  const git = async (...args) => (await run('git', ['-C', cwd, ...args], { timeout: 5000 })).trim();
  let root;
  try {
    root = await git('rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
  const [branch, remotes] = await Promise.all([git('branch', '--show-current').catch(() => ''), git('remote').catch(() => '')]);
  const names = remotes.split('\n').filter(Boolean);
  const remote = names.includes('origin') ? 'origin' : names[0];
  const url = remote ? await git('remote', 'get-url', remote).catch(() => '') : '';
  const parsed = parseRemote(url);
  const gitlab = parsed && !NOT_GITLAB.has(parsed.host.replace(/:\d+$/, '')) ? parsed : { host: null, path: null };
  return { root, branch, remote: remote ?? null, ...gitlab };
}

/** Copies text to the clipboard; false where there is no clipboard command. */
export async function copyText(text) {
  const tool = { darwin: ['pbcopy', []], win32: ['clip', []] }[process.platform] ?? ['xclip', ['-selection', 'clipboard']];
  try {
    await run(tool[0], tool[1], { input: text, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
