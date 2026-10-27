// GitLab for Agentty: the merge request and pipeline of the branch the focused terminal is on,
// read through glab. Failed jobs and unresolved review threads go to an agent as prompts.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createPlugin, ui } from './agentty-plugin.mjs';
import { ACTIVE, ago, cleanLog, duration, firstLine, fixJobPrompt, mergeInfo, mrIcon, statusInfo, tail, threadsPrompt, unresolvedThreads } from './lib/format.mjs';
import { GitLab, copyText, detectRepo, isHost } from './lib/gitlab.mjs';

const plugin = createPlugin();

// A list item and its buttons count toward the panel's 2 000 elements.
const MAX_JOBS = 120;
const MAX_THREADS = 100;
const MY_MRS = 50; // what GitLab returns per list in "My MRs"
const HAS_LOG = new Set(['success', 'failed', 'canceled', 'running']);

/** What belongs to one repository and branch; cleared when the focused pane moves to another. */
const branchData = () => ({
  project: null,
  mr: null,
  pipeline: null,
  jobs: [], // jobs and bridges of the pipeline
  jobsError: null,
  threads: [],
  threadsError: null,
  error: null, // what the last load threw
  job: null, // the job in the popover: { id, job, log, loading, error }
  allJobs: false,
});

const state = {
  tab: 'branch',
  repo: null, // detectRepo() of the focused pane
  loading: false,
  busy: null, // the action in flight: 'job:<id>', 'pipeline', 'fix' or 'threads'
  ...branchData(),
  mine: { host: null, review: [], authored: [], loaded: false, loading: false, error: null, showHidden: false },
};

let panelOpen = false;
let timer = null;
let badge = '';
let lastHost = null; // the GitLab host last seen, for "My MRs" when no repository is focused

const clients = new Map();
function gitlab(host) {
  if (!clients.has(host)) clients.set(host, new GitLab(host));
  return clients.get(host);
}

const log = (...parts) => plugin.log(...parts);
const quietly = (promise) => promise?.catch((err) => log(err?.message ?? String(err)));

// ---------------------------------------------------------------- data
// One update at a time follows the focused pane, then loads its branch; asking during a run makes
// it run again, and the promise resolves once the data is current, so commands can await it.

const repoKey = (repo) => (repo ? `${repo.root}#${repo.branch}` : '');
let running = null;
let again = false;
let loud = false;

function update({ loud: show = false } = {}) {
  loud ||= show;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const showLoading = loud;
        loud = false;
        await syncRepo();
        await load(showLoading);
      } while (again);
    } finally {
      // Before the promise settles, so a call that comes right after starts a new run.
      running = null;
      schedule();
    }
  })();
  return running;
}

/** Errors only the user can clear: polling stops and the panel says what to do. */
const blocking = (err) => err?.kind === 'missing' || err?.kind === 'auth' || err?.status === 404;

async function syncRepo() {
  const cwd = plugin.context?.pane?.cwd;
  if (!cwd) return; // nothing focused: keep showing what we have
  const repo = await detectRepo(cwd);
  if (repoKey(repo) === repoKey(state.repo)) return;
  Object.assign(state, { repo }, branchData());
  if (repo?.host && repo.host !== lastHost) rememberHost(repo.host);
  render();
}

async function load(showLoading) {
  const repo = state.repo;
  if (!repo?.host) {
    state.loading = false;
    updateBadge();
    return render();
  }
  if (showLoading) {
    state.loading = true;
    render();
  }
  try {
    const gl = gitlab(repo.host);
    const project = await gl.project(repo.path);
    const onDefault = repo.branch === project.default_branch;
    const mr = repo.branch && !onDefault ? await gl.branchMr(project.id, repo.branch) : null;
    const pipeline = mr?.head_pipeline ?? (repo.branch ? await gl.latestPipeline(project.id, repo.branch) : null);
    // A pipeline or discussions the account cannot see should not hide the rest.
    const [jobs, discussions] = await Promise.allSettled([
      pipeline ? gl.pipelineJobs(pipeline.project_id ?? project.id, pipeline.id) : [],
      mr?.state === 'opened' ? gl.discussions(project.id, mr.iid) : [],
    ]);
    announce(state.pipeline, pipeline);
    Object.assign(state, {
      project,
      mr,
      pipeline,
      jobs: jobs.value ?? [],
      jobsError: jobs.reason?.message ?? null,
      threads: discussions.value ? unresolvedThreads(discussions.value, mr?.web_url) : [],
      threadsError: discussions.reason?.message ?? null,
      error: null,
    });
  } catch (err) {
    state.error = err;
    log('load failed:', err?.message ?? String(err));
  }
  state.loading = false;
  updateBadge();
  render();
}

/** Polls faster while a pipeline runs and while the panel is open; not at all while the user must act. */
function schedule() {
  clearTimeout(timer);
  if (!state.repo?.host || blocking(state.error)) return;
  const active = ACTIVE.has(state.pipeline?.status);
  const delay = panelOpen ? (active ? 15_000 : 60_000) : active ? 30_000 : 180_000;
  timer = setTimeout(() => quietly(update()), delay);
}

/** Updates when the focused pane is now in another repository or on another branch. */
async function followFocus() {
  const cwd = plugin.context?.pane?.cwd;
  if (!cwd) return;
  const repo = await detectRepo(cwd);
  if (repoKey(repo) !== repoKey(state.repo)) await update({ loud: true });
}

/** Tells the user when the pipeline they are watching finishes. */
function announce(before, after) {
  if (!before || !after || before.id !== after.id) return;
  if (!ACTIVE.has(before.status) || ACTIVE.has(after.status)) return;
  const kind = after.status === 'success' ? 'success' : after.status === 'failed' ? 'error' : 'info';
  quietly(plugin.notify(`Pipeline #${after.id} ${statusInfo(after.status).label} on ${state.repo.branch}`, kind));
}

/** The number of failed jobs on the header button while the branch's pipeline is red. */
function updateBadge() {
  // Once polling has stopped, an old count would only mislead.
  const failed = !blocking(state.error) && state.pipeline?.status === 'failed' ? failedJobs().length || 1 : 0;
  const text = failed ? String(failed) : '';
  if (text === badge) return;
  badge = text;
  quietly(plugin.setBadge(text));
}

function dataFile(name) {
  const dir = plugin.info?.plugin?.dataDir ?? process.env.AGENTTY_PLUGIN_DATA;
  return dir ? join(dir, name) : null;
}

async function loadHost() {
  try {
    const { host } = JSON.parse(await readFile(dataFile('last-host.json'), 'utf8'));
    if (isHost(host)) lastHost = host;
  } catch {
    // first run, or no data folder
  }
}

function rememberHost(host) {
  lastHost = host;
  const file = dataFile('last-host.json');
  if (file) quietly(writeFile(file, JSON.stringify({ host })));
}

// MRs the user hid from "My MRs" (stale ones that cannot be closed), with what the hidden list shows.
const hidden = new Map();
const hiddenKey = (host, id) => `${host} ${id}`;
const isHidden = (mr) => hidden.has(hiddenKey(state.mine.host, mr.id));
let saving = Promise.resolve();

async function loadHidden() {
  try {
    for (const mr of JSON.parse(await readFile(dataFile('hidden-mrs.json'), 'utf8'))) {
      if (isHost(mr?.host) && Number.isInteger(mr.id)) hidden.set(hiddenKey(mr.host, mr.id), mr);
    }
  } catch {
    // nothing hidden yet
  }
}

function saveHidden() {
  const file = dataFile('hidden-mrs.json');
  if (!file) return;
  // One write at a time, each with the list as it is by then.
  saving = saving.then(() => writeFile(file, JSON.stringify([...hidden.values()]))).catch((err) => log('could not save the hidden MRs:', err.message));
}

function hideMr(mr) {
  const host = state.mine.host;
  hidden.set(hiddenKey(host, mr.id), { host, id: mr.id, title: mr.title, ref: mr.references?.full ?? `!${mr.iid}`, url: mr.web_url });
  saveHidden();
  render();
}

function unhideMr(key) {
  hidden.delete(key);
  if (!hiddenHere().length) state.mine.showHidden = false;
  saveHidden();
  render();
}

const hiddenHere = () => [...hidden.values()].filter((mr) => mr.host === state.mine.host);

/** Forgets hidden MRs that are closed or merged; only lists GitLab did not cut short can tell. */
function pruneHidden(host, { review, authored }) {
  if (review.length >= MY_MRS || authored.length >= MY_MRS) return;
  const open = new Set([...review, ...authored].map((mr) => hiddenKey(host, mr.id)));
  let changed = false;
  for (const [key, mr] of hidden) {
    if (mr.host === host && !open.has(key)) {
      hidden.delete(key);
      changed = true;
    }
  }
  if (changed) saveHidden();
}

async function refreshMine() {
  const mine = state.mine;
  const host = state.repo?.host ?? lastHost;
  Object.assign(mine, { host, loading: true });
  render();
  try {
    if (!host) throw new Error('Focus a terminal in a GitLab repository once, so the plugin knows which GitLab to ask.');
    const lists = await gitlab(host).myMrs();
    Object.assign(mine, lists, { loaded: true, error: null });
    pruneHidden(host, lists);
  } catch (err) {
    mine.error = err;
  } finally {
    mine.loading = false;
    render();
  }
}

const failedJobs = () => state.jobs.filter((j) => !j.bridge && j.status === 'failed' && !j.allow_failure);
/** What `POST pipelines/:id/retry` retries: every failed or canceled job, trigger jobs included. */
const retryableJobs = () => state.jobs.filter((j) => ['failed', 'canceled'].includes(j.status));
const jobById = (id) => state.jobs.find((j) => String(j.id) === String(id));
const jobsProject = () => state.pipeline?.project_id ?? state.project?.id;

// ---------------------------------------------------------------- actions

async function withBusy(key, fn) {
  if (state.busy) return plugin.notify('Another GitLab action is still running.', 'info');
  state.busy = key;
  render();
  try {
    await fn();
  } finally {
    state.busy = null;
    render();
  }
}

async function copy(url) {
  if (!url) return;
  if (await copyText(url)) await plugin.notify('Link copied', 'success');
  else await plugin.notify(url, 'info');
}

const open = (url) => url && plugin.openUrl(url);

async function selectJob(id) {
  const job = jobById(id);
  if (!job) return;
  if (job.bridge) return open(job.downstream_pipeline?.web_url ?? job.web_url);
  const hasLog = HAS_LOG.has(job.status);
  // The pipeline goes along: after a push, the popover may still show a job of the one before.
  const popover = { id: job.id, job, pipeline: state.pipeline, log: null, loading: hasLog, error: null };
  state.job = popover;
  render();
  if (!hasLog) return;
  try {
    popover.log = cleanLog(await gitlab(state.repo.host).trace(jobsProject(), job.id));
  } catch (err) {
    popover.error = err?.message ?? String(err);
  } finally {
    popover.loading = false;
    if (state.job === popover) render();
  }
}

async function jobAction(id, action) {
  const inList = jobById(id);
  const popover = String(state.job?.id) === String(id) ? state.job : null;
  const job = inList ?? popover?.job;
  if (!job) return;
  const pipeline = inList ? state.pipeline : popover.pipeline;
  switch (action) {
    case 'open':
      return open(job.bridge ? (job.downstream_pipeline?.web_url ?? job.web_url) : job.web_url);
    case 'copy':
      return copy(job.web_url);
    case 'fix':
      return fixJob(job, pipeline);
    case 'retry': {
      const host = state.repo.host;
      const projectId = pipeline?.project_id ?? state.project?.id;
      return withBusy(`job:${job.id}`, async () => {
        const next = await gitlab(host).retryJob(projectId, job.id);
        await plugin.notify(`Retrying ${job.name}`, 'success');
        // A retry is a new job with a new id; follow it in the popover.
        if (state.job?.id === job.id && next?.id) state.job = { id: next.id, job: next, log: null, loading: false, error: null };
        await update();
      });
    }
  }
}

async function fixJob(job, pipeline = state.pipeline) {
  // Everything the prompt says is taken now: the focused pane may move while the log downloads.
  const { repo, project, mr } = state;
  const projectId = pipeline?.project_id ?? project.id;
  const cachedLog = state.job?.id === job.id && job.status !== 'running' ? state.job.log : null;
  await withBusy('fix', async () => {
    const jobLog = cachedLog ?? cleanLog(await gitlab(repo.host).trace(projectId, job.id));
    await plugin.injectPrompt({
      text: fixJobPrompt({ projectPath: project.path_with_namespace, projectId, job, pipeline, mr, log: jobLog, branch: repo.branch }),
      title: `Fix ${job.name}`,
      target: 'ask',
      cwd: repo.root,
      submit: true,
    });
  });
}

async function addressThreads() {
  const { repo, project, mr, threads } = state;
  if (!mr || !threads.length) return plugin.notify('No unresolved threads.', 'info');
  await withBusy('threads', () =>
    plugin.injectPrompt({
      text: threadsPrompt({ projectPath: project.path_with_namespace, mr, threads }),
      title: `Review of !${mr.iid}`,
      target: 'ask',
      cwd: repo.root,
      submit: true,
    }),
  );
}

async function retryPipeline() {
  const { repo, pipeline } = state;
  const projectId = jobsProject();
  if (!pipeline) return;
  await withBusy('pipeline', async () => {
    await gitlab(repo.host).retryPipeline(projectId, pipeline.id);
    await plugin.notify(`Retrying the failed jobs of pipeline #${pipeline.id}`, 'success');
    await update();
  });
}

function createMrUrl() {
  const { project, repo } = state;
  return project && repo?.branch ? `${project.web_url}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(repo.branch)}` : null;
}

function signIn() {
  const host = state.tab === 'mine' ? state.mine.host : state.repo?.host;
  if (!host) return;
  return plugin.injectPrompt({ text: `glab auth login --hostname ${host}`, title: 'Sign in to GitLab', agent: 'shell', target: 'ask' });
}

/** Brings the data up to date for a palette command, which may run while the panel is closed; false when there is nothing to act on. */
async function ensureFresh() {
  await update();
  if (!state.repo?.host) throw new Error('Focus a terminal inside a GitLab repository first.');
  if (state.error) throw state.error;
  if (state.repo.branch) return true;
  await plugin.notify('HEAD is detached: check out a branch first.', 'info');
  return false;
}

// ---------------------------------------------------------------- drawing

function render() {
  if (!panelOpen) return;
  const reviews = state.mine.review.filter((mr) => !isHidden(mr)).length;
  const tabs = [
    { id: 'branch', label: 'This branch', icon: 'git-branch' },
    { id: 'mine', label: 'My MRs', icon: 'git-pull-request', badge: reviews ? String(reviews) : undefined },
  ];
  quietly(
    plugin.setPanel(
      ui.column([header(), ui.tabs('tabs', tabs, state.tab, state.tab === 'mine' ? mineView() : branchView()), state.job && jobPopover()]),
    ),
  );
}

function header() {
  const repo = state.repo;
  const loading = state.tab === 'mine' ? state.mine.loading : state.loading;
  // A text in a row takes the room its buttons leave; a column there shrinks to one letter.
  return ui.column(
    [
      repo && ui.text(repo.path ?? basename(repo.root), 'title'),
      ui.row([
        ui.text(repo ? repo.branch || 'detached HEAD' : 'No repository', 'muted'),
        ui.button('refresh', 'Refresh', { icon: 'refresh-cw', variant: 'ghost', disabled: loading }),
      ]),
    ],
    { gap: 'none' },
  );
}

function errorView(err, host) {
  const retry = ui.button('retry', 'Try again', { icon: 'refresh-cw' });
  if (err.kind === 'missing') {
    return [ui.callout('Install the GitLab CLI (brew install glab), sign in with glab auth login, then try again.', { title: 'glab is not installed', tone: 'error' }), retry];
  }
  if (err.kind === 'auth') {
    return [
      ui.callout(`Sign in with glab auth login --hostname ${host}, then try again.`, { title: `Not signed in to ${host}`, tone: 'warning' }),
      ui.row([ui.button('signin', 'Sign in in a terminal', { icon: 'key-round', variant: 'primary' }), retry], { gap: 'small', wrap: true }),
    ];
  }
  if (err.status === 404 && state.tab === 'branch') {
    return [ui.callout(`${state.repo.path} is not on ${host}, or your account cannot see it.`, { title: 'Project not found', tone: 'warning' }), retry];
  }
  if (!host) return [ui.callout(err.message, { title: 'No GitLab yet', tone: 'neutral' }), retry];
  return [ui.callout(err.message ?? String(err), { title: 'Could not reach GitLab', tone: 'error' }), retry];
}

function branchView() {
  const repo = state.repo;
  if (!repo) {
    return [ui.callout('Focus a terminal inside a GitLab repository to see its merge request and pipeline.', { title: 'No repository', icon: 'folder-git-2', tone: 'neutral' })];
  }
  if (!repo.host) return [ui.callout(`${basename(repo.root)} has no GitLab remote.`, { title: 'Not a GitLab repository', tone: 'neutral' })];
  if (state.error && (!state.project || blocking(state.error))) return errorView(state.error, repo.host);
  if (!state.project) return [ui.spinner(`Loading ${repo.path}…`)];
  if (!repo.branch) return [ui.callout('HEAD is detached. Check out a branch to see its merge request.', { tone: 'neutral' })];
  return [
    state.error && ui.callout(`Showing what was loaded before: ${state.error.message}`, { title: 'Refresh failed', tone: 'warning' }),
    mrCard(),
    pipelineCard(),
    threadsSection(),
  ];
}

function mrCard() {
  const { mr, repo, project } = state;
  if (!mr) {
    if (repo.branch === project.default_branch) return null;
    return ui.card(
      [
        ui.text(`No merge request for ${repo.branch} yet.`, 'muted'),
        ui.row([ui.button('mr.create', 'Create merge request', { icon: 'git-pull-request' })]),
      ],
      { title: 'Merge request', icon: 'git-pull-request' },
    );
  }
  const [label, tone] = mergeInfo(mr);
  const isOpen = mr.state === 'opened';
  const n = state.threads.length;
  return ui.card(
    [
      ui.keyValue(
        [
          { label: 'Status', value: label, tone },
          { label: 'Into', value: mr.target_branch, mono: true },
          isOpen && !state.threadsError && { label: 'Threads', value: n ? `${n} unresolved` : 'all resolved', tone: n ? 'warning' : 'success' },
          mr.reviewers?.length > 0 && { label: 'Reviewers', value: mr.reviewers.map((r) => r.username).join(', ') },
        ].filter(Boolean),
      ),
      ui.row(
        [
          isOpen && n > 0 && ui.button('mr.threads', 'Address threads', { icon: 'bot', variant: 'primary', disabled: !!state.busy }),
          ui.button('mr.open', 'Open', { icon: 'external-link' }),
          ui.button('mr.copy', 'Copy link', { icon: 'copy', variant: 'ghost' }),
        ],
        { gap: 'small', wrap: true },
      ),
    ],
    { title: mr.title, subtitle: `!${mr.iid} · ${mr.draft ? 'draft · ' : ''}updated ${ago(mr.updated_at)}`, icon: 'git-pull-request', tone },
  );
}

// Failures first, then what is running, then the rest in pipeline order.
const rank = (j) => (j.status === 'failed' ? (j.allow_failure ? 1 : 0) : ACTIVE.has(j.status) ? 2 : 3);
const notable = (j) => j.status === 'failed' || (ACTIVE.has(j.status) && j.status !== 'created') || (j.bridge && j.status !== 'skipped');

function pipelineCard() {
  const p = state.pipeline;
  if (!p) return ui.card([ui.text(`No pipeline for ${state.repo.branch}.`, 'muted')], { title: 'Pipeline', icon: 'workflow' });
  const info = statusInfo(p.status);
  const jobs = state.jobs;
  const failed = failedJobs();
  const shown = (state.allJobs ? jobs : jobs.filter(notable)).slice().sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const counted = jobs.filter((j) => !['manual', 'skipped', 'scheduled'].includes(j.status));
  const finished = counted.filter((j) => !ACTIVE.has(j.status));
  const subtitle = [info.label, p.duration ? duration(p.duration) : ago(p.updated_at ?? p.created_at), p.sha?.slice(0, 8)].filter(Boolean).join(' · ');
  return ui.card(
    [
      ACTIVE.has(p.status) &&
        counted.length > 0 &&
        ui.progress(finished.length / counted.length, { label: `${finished.length} of ${counted.length} jobs finished`, tone: failed.length ? 'error' : 'info' }),
      state.jobsError
        ? ui.callout(state.jobsError, { title: 'Could not load the jobs', tone: 'warning' })
        : ui.list('jobs', shown.slice(0, MAX_JOBS).map(jobItem), { empty: 'Nothing failed or running.' }),
      shown.length > MAX_JOBS && ui.text(`and ${shown.length - MAX_JOBS} more: open the pipeline to see them.`, 'small'),
      jobs.length > shown.length || state.allJobs
        ? ui.button('jobs.all', state.allJobs ? 'Show only what needs a look' : `Show all ${jobs.length} jobs`, {
            icon: state.allJobs ? 'chevron-up' : 'chevron-down',
            variant: 'ghost',
          })
        : null,
      ui.row(
        [
          retryableJobs().length > 0 && ui.button('pipeline.retry', 'Retry failed jobs', { icon: 'rotate-cw', disabled: !!state.busy }),
          ui.button('pipeline.open', 'Open', { icon: 'external-link', variant: 'ghost' }),
        ],
        { gap: 'small', wrap: true },
      ),
    ],
    { title: `Pipeline #${p.id}`, subtitle, icon: 'workflow', tone: info.tone },
  );
}

function jobItem(j) {
  const status = j.bridge ? (j.downstream_pipeline?.status ?? j.status) : j.status;
  const info = statusInfo(status, { allowFailure: j.allow_failure });
  const actions = [];
  if (!j.bridge && j.status === 'failed') actions.push({ id: 'fix', icon: 'bot', tooltip: 'Fix with an agent' });
  if (!j.bridge && ['failed', 'canceled'].includes(j.status)) actions.push({ id: 'retry', icon: 'rotate-cw', tooltip: 'Retry' });
  actions.push({ id: 'open', icon: 'external-link', tooltip: 'Open in GitLab' });
  return {
    id: String(j.id),
    title: j.name,
    subtitle: [j.stage, j.bridge && 'downstream', duration(j.duration)].filter(Boolean).join(' · '),
    detail: state.busy === `job:${j.id}` ? 'working…' : info.label,
    icon: j.bridge ? 'workflow' : info.icon,
    tone: info.tone,
    actions,
  };
}

function threadsSection() {
  if (state.mr?.state !== 'opened') return null;
  if (state.threadsError) return ui.section('Unresolved threads', [ui.callout(state.threadsError, { title: 'Could not load the threads', tone: 'warning' })]);
  const items = state.threads.slice(0, MAX_THREADS).map((t) => ({
    id: t.id,
    title: firstLine(t.notes[0]?.body) || '(no text)',
    subtitle: [`@${t.author}`, t.file].filter(Boolean).join(' · '),
    detail: ago(t.createdAt),
    icon: 'message-square',
    tone: 'warning',
    actions: [{ id: 'open', icon: 'external-link', tooltip: 'Open in GitLab' }],
  }));
  const more = state.threads.length - items.length;
  return ui.section(`Unresolved threads (${state.threads.length})`, [
    ui.list('threads', items, { empty: 'No unresolved threads.' }),
    more > 0 && ui.text(`and ${more} more: open the merge request to see them.`, 'small'),
  ]);
}

function jobPopover() {
  // The list may have a newer copy of the job than the one that was clicked.
  const job = jobById(state.job.id) ?? state.job.job;
  const { log, loading, error } = state.job;
  const info = statusInfo(job.status, { allowFailure: job.allow_failure });
  const busy = !!state.busy;
  let body = null;
  if (loading) body = ui.spinner('Loading the log…');
  else if (error) body = ui.callout(error, { title: 'Could not load the log', tone: 'error' });
  else if (log != null) body = ui.code(tail(log, 40, 6000) || '(empty log)', { language: 'sh', title: 'Last 40 lines' });
  return ui.popover('job.popover', job.name, [
    ui.keyValue(
      [
        { label: 'Status', value: info.label, tone: info.tone },
        { label: 'Stage', value: job.stage },
        job.duration != null && { label: 'Took', value: duration(job.duration) },
        job.failure_reason && { label: 'Reason', value: job.failure_reason.replace(/_/g, ' ') },
        job.runner?.description && { label: 'Runner', value: job.runner.description },
      ].filter(Boolean),
    ),
    body,
    ui.row(
      [
        job.status === 'failed' && ui.button('job.fix', 'Fix with an agent', { icon: 'bot', variant: 'primary', disabled: busy }),
        ['failed', 'canceled'].includes(job.status) && ui.button('job.retry', 'Retry', { icon: 'rotate-cw', disabled: busy }),
        ui.button('job.open', 'Open', { icon: 'external-link', variant: 'ghost' }),
        ui.button('job.copy', 'Copy link', { icon: 'copy', variant: 'ghost' }),
      ],
      { gap: 'small', wrap: true },
    ),
  ]);
}

function mineView() {
  const m = state.mine;
  if (m.error) return errorView(m.error, m.host);
  if (!m.loaded) return [ui.spinner('Loading your merge requests…')];
  const capped = m.review.length >= MY_MRS || m.authored.length >= MY_MRS;
  const review = m.review.filter((mr) => !isHidden(mr));
  const authored = m.authored.filter((mr) => !isHidden(mr));
  const hiddenMrs = hiddenHere();
  return [
    ui.section(`Review requested (${review.length})`, [ui.list('mine.review', review.map((mr) => mrItem(mr, true)), { empty: 'Nobody is waiting for your review.' })]),
    ui.section(`Yours (${authored.length})`, [ui.list('mine.authored', authored.map((mr) => mrItem(mr, false)), { empty: 'You have no open merge requests.' })]),
    hiddenMrs.length > 0 &&
      ui.button('mine.showHidden', m.showHidden ? 'Collapse hidden' : `Show ${hiddenMrs.length} hidden`, {
        icon: m.showHidden ? 'chevron-up' : 'chevron-down',
        variant: 'ghost',
      }),
    m.showHidden && hiddenMrs.length > 0 && ui.section(`Hidden (${hiddenMrs.length})`, [ui.list('mine.hidden', hiddenMrs.map(hiddenItem))]),
    ui.text(`On ${m.host}${capped ? ` · the ${MY_MRS} updated last of each list` : ''}`, 'small'),
  ];
}

function hiddenItem(mr) {
  return { id: String(mr.id), title: mr.title, subtitle: mr.ref, icon: 'eye-off', tone: 'neutral', actions: [{ id: 'unhide', icon: 'eye', tooltip: 'Show again' }] };
}

function mrItem(mr, withAuthor) {
  const { icon, tone } = mrIcon(mr);
  return {
    id: String(mr.id),
    title: mr.title,
    subtitle: [mr.references?.full ?? `!${mr.iid}`, withAuthor ? `@${mr.author?.username}` : mergeInfo(mr)[0]].join(' · '),
    detail: ago(mr.updated_at),
    icon,
    tone,
    actions: [
      { id: 'copy', icon: 'copy', tooltip: 'Copy link' },
      { id: 'hide', icon: 'eye-off', tooltip: 'Hide from this list' },
    ],
  };
}

// ---------------------------------------------------------------- wiring

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const refreshTab = () => (state.tab === 'mine' ? refreshMine() : update({ loud: true }));

const mineEvent = (key) => (event) => {
  const mr = state.mine[key].find((m) => String(m.id) === event.item);
  if (!mr) return;
  if (event.event !== 'action') return open(mr.web_url);
  return event.action === 'hide' ? hideMr(mr) : copy(mr.web_url);
};

// A branch switch in the focused terminal does not change its folder, so look every few seconds.
setInterval(() => {
  if (panelOpen) quietly(followFocus());
}, 5000);

plugin
  .onActivate(async () => {
    await Promise.all([loadHost(), loadHidden()]);
    // Not awaited: Agentty waits for activation before it sends anything else.
    setTimeout(() => quietly(update()), 0);
  })
  .onPanelOpen(async () => {
    panelOpen = true;
    if (state.repo) render(); // otherwise the update draws it once it knows where the pane is
    if (state.tab === 'mine') quietly(refreshMine());
    await update({ loud: !state.project });
  })
  .onPanelClose(() => {
    panelOpen = false;
    schedule();
  })
  .onContextChange(debounce(() => quietly(followFocus()), 300))
  .onEvent('tabs', (event) => {
    state.tab = event.value;
    render();
    const m = state.mine;
    if (state.tab === 'mine' && !m.loading && (!m.loaded || (state.repo?.host && m.host !== state.repo.host))) return refreshMine();
  })
  .onEvent('refresh', refreshTab)
  .onEvent('retry', refreshTab)
  .onEvent('signin', signIn)
  .onEvent('jobs.all', () => {
    state.allJobs = !state.allJobs;
    render();
  })
  .onEvent('jobs', (event) => (event.event === 'action' ? jobAction(event.item, event.action) : selectJob(event.item)))
  .onEvent('job.popover', () => {
    state.job = null;
    render();
  })
  .onEvent('job.fix', () => jobAction(state.job?.id, 'fix'))
  .onEvent('job.retry', () => jobAction(state.job?.id, 'retry'))
  .onEvent('job.open', () => jobAction(state.job?.id, 'open'))
  .onEvent('job.copy', () => jobAction(state.job?.id, 'copy'))
  .onEvent('mr.open', () => open(state.mr?.web_url))
  .onEvent('mr.copy', () => copy(state.mr?.web_url))
  .onEvent('mr.create', () => open(createMrUrl()))
  .onEvent('mr.threads', addressThreads)
  .onEvent('pipeline.open', () => open(state.pipeline?.web_url))
  .onEvent('pipeline.retry', retryPipeline)
  .onEvent('threads', (event) => open(state.threads.find((t) => t.id === event.item)?.url))
  .onEvent('mine.review', mineEvent('review'))
  .onEvent('mine.authored', mineEvent('authored'))
  .onEvent('mine.showHidden', () => {
    state.mine.showHidden = !state.mine.showHidden;
    render();
  })
  .onEvent('mine.hidden', (event) => {
    const key = hiddenKey(state.mine.host, event.item);
    const mr = hidden.get(key);
    if (!mr) return;
    return event.event === 'action' ? unhideMr(key) : open(mr.url);
  })
  .command('gitlab.openMr', async () => {
    if (!(await ensureFresh())) return;
    if (state.mr) return open(state.mr.web_url);
    if (state.repo.branch === state.project.default_branch) return plugin.notify(`${state.repo.branch} is the default branch: there is no merge request to open.`, 'info');
    return open(createMrUrl());
  })
  .command('gitlab.openPipeline', async () => {
    if (!(await ensureFresh())) return;
    if (!state.pipeline) return plugin.notify(`No pipeline for ${state.repo.branch}.`, 'info');
    return open(state.pipeline.web_url);
  })
  .command('gitlab.fixFailedJob', async () => {
    if (!(await ensureFresh())) return;
    const [job] = failedJobs();
    if (job) return fixJob(job);
    if (!state.pipeline) return plugin.notify(`No pipeline for ${state.repo.branch}.`, 'info');
    if (retryableJobs().some((j) => j.bridge)) return plugin.notify('Only a downstream pipeline failed or was canceled: open it from the panel.', 'info');
    return plugin.notify(`Nothing failed in pipeline #${state.pipeline.id}.`, 'info');
  })
  .command('gitlab.addressThreads', async () => {
    if (!(await ensureFresh())) return;
    return addressThreads();
  })
  .command('gitlab.retryPipeline', async () => {
    if (!(await ensureFresh())) return;
    if (!retryableJobs().length) return plugin.notify('Nothing failed to retry.', 'info');
    return retryPipeline();
  })
  .start();
