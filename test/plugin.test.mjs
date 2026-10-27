// Drives main.mjs the way Agentty does (JSON-RPC over stdio), against a fake glab and real git repos.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agentty-gitlab-')));
const repo = join(tmp, 'proj');
const locked = join(tmp, 'locked');
const log = join(tmp, 'glab.log');
const fixtures = join(tmp, 'fixtures.json');

const WEB = 'https://gitlab.example.com/group/proj';
const MR = {
  iid: 12,
  title: 'Add the thing',
  state: 'opened',
  draft: false,
  detailed_merge_status: 'discussions_not_resolved',
  target_branch: 'main',
  web_url: `${WEB}/-/merge_requests/12`,
  updated_at: new Date().toISOString(),
  reviewers: [{ username: 'alice' }],
  head_pipeline: { id: 100, project_id: 7, status: 'failed', web_url: `${WEB}/-/pipelines/100`, sha: 'abcdef1234567890', duration: 125 },
};
const UNIT = { id: 2, name: 'unit', stage: 'test', status: 'failed', allow_failure: false, ref: 'refs/merge-requests/12/head', web_url: `${WEB}/-/jobs/2`, failure_reason: 'script_failure', duration: 31 };
const note = (id, body, resolved, extra = {}) => ({ id, body, resolvable: true, resolved, author: { username: 'alice' }, ...extra });
// A full first page of resolved threads, so the open one on page 2 only shows if paging works.
const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, notes: [note(1000 + i, `Resolved already ${i}`, true)] }));
page1[0] = { id: 'd1', notes: [note(55, 'Please rename this', false, { position: { new_path: 'src/a.js', new_line: 3 } })] };

writeFileSync(
  fixtures,
  JSON.stringify({
    'GET projects/group%2Fproj': { id: 7, path_with_namespace: 'group/proj', web_url: WEB, default_branch: 'main' },
    'GET projects/7/merge_requests?source_branch=feature&state=opened&per_page=20': [
      { iid: 99, source_project_id: 1234 }, // a fork's MR with the same branch name
      { iid: 12, source_project_id: 7 },
    ],
    'GET projects/7/merge_requests/12': MR,
    'GET projects/7/pipelines/100/jobs?per_page=100&page=1': [
      { id: 1, name: 'lint', stage: 'test', status: 'success', web_url: `${WEB}/-/jobs/1` },
      UNIT,
      { id: 3, name: 'deploy rc', stage: 'deploy', status: 'manual', web_url: `${WEB}/-/jobs/3` },
    ],
    'GET projects/7/pipelines/100/bridges?per_page=100&page=1': [],
    'GET projects/7/merge_requests/12/discussions?per_page=100&page=1': page1,
    'GET projects/7/merge_requests/12/discussions?per_page=100&page=2': [{ id: 'd2', notes: [note(56, 'Second page thread', false)] }],
    'GET projects/7/jobs/2/trace': '2026-10-26T15:33:22.000000Z 01E \x1b[31mAssertionError: expected 2 to equal 3\x1b[0m\n2026-10-26T15:33:26.000000Z 00O ERROR: Job failed: exit code 1\n',
    'POST projects/7/jobs/2/retry': { ...UNIT, id: 4, status: 'pending' },
    'GET user': { id: 5, username: 'me' },
    'GET merge_requests?reviewer_id=5&scope=all&state=opened&order_by=updated_at&per_page=50': [
      { id: 900, iid: 3, title: 'Review me', references: { full: 'other/repo!3' }, author: { username: 'bob' }, web_url: 'https://gitlab.example.com/other/repo/-/merge_requests/3', updated_at: new Date().toISOString() },
    ],
    'GET merge_requests?scope=created_by_me&state=opened&order_by=updated_at&per_page=50': [],
  }),
);
writeFileSync(log, '');
const hiddenFile = join(tmp, 'hidden-mrs.json');
// Hidden before: an MR that has since been merged (no longer listed) and one on another GitLab.
writeFileSync(
  hiddenFile,
  JSON.stringify([
    { host: 'gitlab.example.com', id: 777, title: 'Merged since', ref: 'group/proj!7', url: `${WEB}/-/merge_requests/7` },
    { host: 'gitlab.other.example', id: 1, title: 'Elsewhere', ref: 'x/y!1', url: 'https://gitlab.other.example/x/y/-/merge_requests/1' },
  ]),
);

for (const [dir, remote] of [
  [repo, 'git@gitlab.example.com:group/proj.git'],
  [locked, 'git@locked.example.com:group/secret.git'],
]) {
  execFileSync('git', ['init', '-q', '-b', 'feature', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
}

let child;
const received = [];
const waiters = [];

function send(message) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

/** Resolves with the first message (seen or to come) after `from` that matches. */
function waitFor(match, { from = 0, timeout = 5000 } = {}) {
  const found = received.slice(from).find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve: (message) => {
        clearTimeout(waiter.timer);
        resolve(message);
      },
    };
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(`timed out waiting; last messages: ${JSON.stringify(received.slice(-3)).slice(0, 2000)}`));
    }, timeout);
    waiters.push(waiter);
  });
}

const panelWith = (text) => (m) => m.method === 'ui/setPanel' && JSON.stringify(m.params.tree).includes(text);
const context = (cwd) => ({ pane: { id: 1, kind: 'claude', status: 'idle', cwd }, language: 'en' });
const event = (params) => send({ method: 'ui/event', params: { context: context(repo), ...params } });
/** The panel redraw that ends an action (the plugin refuses a second action while one runs). */
const settled = (message) => waitFor((m) => m.method === 'ui/setPanel', { from: received.indexOf(message) + 1 });

/** Retries `check` until it stops throwing: for files the plugin writes after it redraws. */
async function eventually(check, timeout = 2000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

before(async () => {
  child = spawn(process.execPath, [join(root, 'main.mjs')], {
    env: { ...process.env, PATH: `${join(root, 'test', 'fake-bin')}:${process.env.PATH}`, FAKE_GLAB_LOG: log, FAKE_GLAB_FIXTURES: fixtures },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    received.push(message);
    // Agentty answers every call; the plugin waits for it.
    if (message.method && message.id !== undefined) send({ id: message.id, result: message.method === 'prompt/inject' ? { status: 'asked' } : null });
    for (const w of [...waiters]) {
      if (w.match(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  });
  send({ id: 1000, method: 'initialize', params: { apiVersion: 4, agentty: { version: 'test' }, plugin: { id: 'gitlab', dir: root, dataDir: tmp }, language: 'en', context: null } });
  await waitFor((m) => m.id === 1000 && m.result);
});

after(() => child?.kill());

test('outside a repository the panel says so', async () => {
  const from = received.length;
  send({ method: 'panel/open', params: { context: context(tmp) } });
  await waitFor(panelWith('"title":"No repository"'), { from });
});

test('in a repository it shows the MR, the failed job and the unresolved threads of every page', async () => {
  const from = received.length;
  send({ method: 'context/changed', params: { context: context(repo) } });
  const panel = await waitFor(panelWith('Pipeline #100'), { from });
  const tree = JSON.stringify(panel.params.tree);
  assert.match(tree, /group\/proj/);
  assert.match(tree, /Add the thing/, 'the project\'s own MR, not the fork\'s');
  assert.match(tree, /Unresolved threads \(2\)/);
  assert.match(tree, /Please rename this/);
  assert.match(tree, /Second page thread/);
  assert.doesNotMatch(tree, /Resolved already/);
  assert.match(tree, /Retry failed jobs/);
  assert.match(tree, /"title":"unit"/);
  assert.doesNotMatch(tree, /"title":"lint"/, 'passed jobs stay behind "Show all"');
  const badge = await waitFor((m) => m.method === 'ui/setBadge', { from });
  assert.equal(badge.params.text, '1');
});

test('"Fix with an agent" asks the user where to send the job log', async () => {
  const from = received.length;
  event({ element: 'jobs', event: 'action', item: '2', action: 'fix' });
  const inject = await waitFor((m) => m.method === 'prompt/inject', { from });
  assert.equal(inject.params.target, 'ask');
  assert.equal(inject.params.cwd, repo);
  assert.match(inject.params.text, /The GitLab CI job "unit" \(stage test\) failed in pipeline #100 of group\/proj, branch feature\./);
  assert.match(inject.params.text, /AssertionError: expected 2 to equal 3\nERROR: Job failed: exit code 1/);
  assert.match(inject.params.text, /glab api projects\/7\/jobs\/2\/trace/);
  assert.doesNotMatch(inject.params.text, /\x1b|2026-10-26T/);
  await settled(inject);
});

test('"Address threads" sends only the unresolved threads', async () => {
  const from = received.length;
  event({ element: 'mr.threads', event: 'click' });
  const inject = await waitFor((m) => m.method === 'prompt/inject', { from });
  assert.match(inject.params.text, /1\. src\/a\.js:3 \(https:\/\/gitlab\.example\.com\/group\/proj\/-\/merge_requests\/12#note_55\)/);
  assert.match(inject.params.text, /> Please rename this/);
  assert.match(inject.params.text, /> Second page thread/);
  assert.doesNotMatch(inject.params.text, /Resolved already/);
  await settled(inject);
});

test('clicking a failed job shows its log in a popover', async () => {
  const from = received.length;
  event({ element: 'jobs', event: 'select', item: '2' });
  const panel = await waitFor(panelWith('Last 40 lines'), { from });
  assert.match(JSON.stringify(panel.params.tree), /"type":"popover"/);
  event({ element: 'job.popover', event: 'close' });
  await waitFor((m) => m.method === 'ui/setPanel' && !JSON.stringify(m.params.tree).includes('"type":"popover"'), { from: received.indexOf(panel) + 1 });
});

test('manual jobs can be opened but never started from the panel', async () => {
  const from = received.length;
  event({ element: 'jobs.all', event: 'click' });
  const panel = await waitFor(panelWith('"title":"deploy rc"'), { from });
  const findItem = (node) => node?.items?.find((i) => i.title === 'deploy rc') ?? (node?.children ?? []).map(findItem).find(Boolean);
  assert.deepEqual(findItem(panel.params.tree).actions.map((a) => a.id), ['open']);
  event({ element: 'jobs', event: 'action', item: '3', action: 'play' });
  event({ element: 'jobs.all', event: 'click' });
  await waitFor((m) => m.method === 'ui/setPanel' && !JSON.stringify(m.params.tree).includes('"title":"deploy rc"'), { from: received.indexOf(panel) + 1 });
  assert.doesNotMatch(readFileSync(log, 'utf8'), /^POST .*\/play$/m);
});

test('retry posts to GitLab and says so', async () => {
  const from = received.length;
  event({ element: 'jobs', event: 'action', item: '2', action: 'retry' });
  const notice = await waitFor((m) => m.method === 'ui/notify', { from });
  assert.equal(notice.params.message, 'Retrying unit');
  assert.match(readFileSync(log, 'utf8'), /^POST projects\/7\/jobs\/2\/retry$/m);
  await settled(notice);
});

test('a palette command loads fresh data even with the panel closed', async () => {
  send({ method: 'panel/close', params: { context: context(repo) } });
  const from = received.length;
  const calls = readFileSync(log, 'utf8').length;
  send({ method: 'command/execute', params: { command: 'gitlab.openMr', args: {}, context: context(repo) } });
  const opened = await waitFor((m) => m.method === 'host/openUrl', { from });
  assert.equal(opened.params.url, MR.web_url);
  assert.match(readFileSync(log, 'utf8').slice(calls), /GET projects\/7\/merge_requests\/12\n/);
  send({ method: 'panel/open', params: { context: context(repo) } });
  await waitFor(panelWith('Pipeline #100'), { from });
});

test('"My MRs" lists what waits for review', async () => {
  const from = received.length;
  event({ element: 'tabs', event: 'change', value: 'mine' });
  const panel = await waitFor(panelWith('Review requested (1)'), { from });
  const tree = JSON.stringify(panel.params.tree);
  assert.match(tree, /Review me/);
  assert.match(tree, /other\/repo!3 · @bob/);
  assert.match(tree, /You have no open merge requests/);
  assert.match(tree, /"badge":"1"/);
  assert.doesNotMatch(tree, /Show \d+ hidden/, 'the merged MR and the other host\'s are not counted here');
  event({ element: 'tabs', event: 'change', value: 'branch' });
  await waitFor(panelWith('Pipeline #100'), { from: received.indexOf(panel) + 1 });
});

test('a hidden MR leaves "My MRs" and its badge until it is shown again', async () => {
  const savedIds = () => JSON.parse(readFileSync(hiddenFile, 'utf8')).map((mr) => mr.id);
  let from = received.length;
  event({ element: 'tabs', event: 'change', value: 'mine' });
  await waitFor(panelWith('Review requested (1)'), { from });
  assert.deepEqual(savedIds(), [1], 'loading the lists forgot the merged MR, not the other host\'s');

  from = received.length;
  event({ element: 'mine.review', event: 'action', item: '900', action: 'hide' });
  let tree = JSON.stringify((await waitFor(panelWith('Review requested (0)'), { from })).params.tree);
  assert.doesNotMatch(tree, /Review me/);
  assert.doesNotMatch(tree, /"badge"/);
  assert.match(tree, /Show 1 hidden/);
  await eventually(() => assert.deepEqual(savedIds(), [1, 900]));

  from = received.length;
  event({ element: 'mine.showHidden', event: 'click' });
  tree = JSON.stringify((await waitFor(panelWith('Hidden (1)'), { from })).params.tree);
  assert.match(tree, /Review me/);
  assert.doesNotMatch(tree, /Elsewhere/);

  from = received.length;
  event({ element: 'mine.hidden', event: 'action', item: '900', action: 'unhide' });
  tree = JSON.stringify((await waitFor(panelWith('Review requested (1)'), { from })).params.tree);
  assert.doesNotMatch(tree, /Hidden \(|Show \d+ hidden/);
  await eventually(() => assert.deepEqual(savedIds(), [1]));

  from = received.length;
  event({ element: 'tabs', event: 'change', value: 'branch' });
  await waitFor(panelWith('Pipeline #100'), { from });
});

test('a host glab is not signed in to offers to sign in', async () => {
  const from = received.length;
  send({ method: 'context/changed', params: { context: context(locked) } });
  const panel = await waitFor(panelWith('Not signed in to locked.example.com'), { from });
  assert.match(JSON.stringify(panel.params.tree), /Sign in in a terminal/);
  event({ element: 'signin', event: 'click', context: context(locked) });
  const inject = await waitFor((m) => m.method === 'prompt/inject', { from });
  assert.deepEqual([inject.params.text, inject.params.agent, inject.params.target], ['glab auth login --hostname locked.example.com', 'shell', 'ask']);
});
