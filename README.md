# GitLab for Agentty

An [Agentty](https://www.agentty.run) plugin that shows the merge request and pipeline of the branch
your focused terminal is on, and hands GitLab work to your agent.

- **This branch**: the branch's MR (merge status, target, reviewers, unresolved threads), its
  pipeline with what failed or is still running (everything else behind *Show all*), and the
  unresolved review threads. Click a job to see the end of its log.
- **Fix with an agent**: on a failed job, sends the agent a prompt with the job, the MR and the
  last 150 lines of the log (colors, timestamps and section markers stripped).
- **Address threads**: sends the agent every unresolved review thread with file, line, comments
  and replies, and asks it to fix what the reviewer is right about without replying on GitLab.
- **Retry / Open / Copy link**: retry a failed job, or every failed and canceled job of the pipeline
  (downstream triggers and allowed failures included, as GitLab does), and open anything in GitLab.
  Manual jobs (deploys and the like) are listed but never started from the panel.
- **My MRs**: open MRs waiting for your review and the ones you wrote, on the focused repo's host.
- A badge with the number of failed jobs while the branch's pipeline is red, and a notification
  when a pipeline you are watching finishes.

Prompts go through Agentty's **Send to…** dialog, so you see the text and pick the agent and tab
before anything is sent. The command palette has the same actions (`GitLab: …`).

## Requirements

- [glab](https://gitlab.com/gitlab-org/cli), signed in to your GitLab host (`glab auth login
  --hostname gitlab.example.com`). The plugin calls `glab api` for everything and never sees a
  token, so self-hosted GitLab works the same as gitlab.com.
- Node.js 18 or newer on the login shell's `PATH`.

The project and host come from the `origin` remote of the focused terminal's repository (or its
first remote). An SSH host alias from `~/.ssh/config` (`git@work-gitlab:group/repo`) is not
resolved, so use the real host name in the remote. Repositories on GitHub, Bitbucket and the like
are left alone. Permissions: `workspace.read` (the focused terminal's folder) and `prompt.inject`
(the hand-offs).

## Install

**Plugins → Build your own → Install from Git** with `https://github.com/paul27et/agentty-gitlab`,
or clone it and use **Plugins → Link Folder for Development…**.

## Develop

```sh
npm test   # node --test: helpers, plus main.mjs driven over stdio against a fake glab
```

`agentty-plugin.mjs` is Agentty's Node SDK, copied unchanged. After editing, press **Restart** on
the plugin's card; **Logs** shows its stderr.
