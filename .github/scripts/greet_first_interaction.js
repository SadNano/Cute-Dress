const { resolveWorkflowRunPR } = require('./workflow_run_pr');

const GREETING_MARKER = '<!-- first-pr-greeting -->';

async function alreadyGreeted(github, owner, repo, prNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return comments.some(comment =>
    comment.user && comment.user.login === 'github-actions[bot]' &&
    comment.body && comment.body.includes(GREETING_MARKER)
  );
}

async function isFirstInteractionPR(github, owner, repo, login, currentPR) {
  const interactions = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    creator: login,
    state: 'all',
    per_page: 100,
    sort: 'created',
    direction: 'asc',
  });
  const first = interactions
    .filter(item => item.number)
    .sort((left, right) =>
      left.created_at.localeCompare(right.created_at) || left.number - right.number
    )[0];
  if (!first) return interactions.length === 0;
  return first.number === currentPR;
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const workflowRun = context.payload.workflow_run;
  if (workflowRun.event !== 'pull_request') return;

  const pr = await resolveWorkflowRunPR(
    github,
    owner,
    repo,
    workflowRun,
    '.github/workflows/pr_opened_signal.yml'
  );
  if (!pr) {
    core.info('No current open pull request matches the signal run.');
    return;
  }

  const author = pr.user && pr.user.login;
  if (!author || !/^[A-Za-z0-9-]+$/.test(author)) {
    core.info('Pull request author is unavailable.');
    return;
  }

  if (await alreadyGreeted(github, owner, repo, pr.number)) {
    core.info('This pull request was already greeted.');
    return;
  }

  if (!await isFirstInteractionPR(github, owner, repo, author, pr.number)) {
    core.info('The author has an earlier issue or pull request in this repository.');
    return;
  }

  const latest = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (latest.data.state !== 'open' || latest.data.head.sha !== pr.head.sha) {
    core.info('Pull request changed during inspection; no greeting posted.');
    return;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: [
      `你好 @${author}，感谢提交PR！`,
      `Hi @${author}, thanks for opening the Pull Request!`,
      '我们会尽早审核回应。',
      'We will respond to it as soon as possible.',
      '',
      GREETING_MARKER,
    ].join('\n'),
  });
}

module.exports = { run };
