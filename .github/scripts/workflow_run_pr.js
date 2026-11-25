async function resolveWorkflowRunPR(github, owner, repo, run, expectedWorkflowPath) {
  const workflow = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: run.workflow_id,
  });
  if ((workflow.data.path || '').split('@')[0] !== expectedWorkflowPath) return null;

  const headRepo = run.head_repository;
  if (!headRepo || !headRepo.owner || !run.head_branch) return null;

  const associatedMatches = (run.pull_requests || []).filter(candidate =>
    candidate.number &&
    candidate.head &&
    candidate.head.sha &&
    candidate.head.repo &&
    candidate.head.repo.id === headRepo.id
  );

  if (associatedMatches.length === 1) {
    const associated = associatedMatches[0];
    const response = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: associated.number,
    });
    const pr = response.data;
    if (
      pr.state === 'open' &&
      pr.head.sha === associated.head.sha &&
      pr.head.repo &&
      pr.head.repo.id === headRepo.id
    ) return pr;
    return null;
  }
  if (associatedMatches.length > 1) return null;

  const { data: candidates } = await github.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${headRepo.owner.login}:${run.head_branch}`,
    per_page: 100,
  });
  const exactMatches = candidates.filter(candidate =>
    (candidate.head.sha === run.head_sha || candidate.merge_commit_sha === run.head_sha) &&
    candidate.head.ref === run.head_branch &&
    candidate.head.repo &&
    candidate.head.repo.id === headRepo.id
  );
  if (exactMatches.length !== 1) return null;
  const response = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: exactMatches[0].number,
  });
  const pr = response.data;
  if (
    pr.state !== 'open' ||
    pr.head.sha !== exactMatches[0].head.sha ||
    pr.head.ref !== run.head_branch ||
    !pr.head.repo ||
    pr.head.repo.id !== headRepo.id ||
    (exactMatches[0].merge_commit_sha === run.head_sha && pr.merge_commit_sha !== run.head_sha)
  ) return null;
  return pr;
}

module.exports = { resolveWorkflowRunPR };
