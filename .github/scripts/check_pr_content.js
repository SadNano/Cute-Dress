const { resolveWorkflowRunPR } = require('./workflow_run_pr');

const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|tiff?|hei[cf]|avif|gif|bmp)$/i;
const ACTIVE_STATUSES = new Set(['added', 'modified', 'renamed', 'copied']);
const PR_TYPE_RE = /<!--\s*pr-type:\s*(\S+)\s*-->/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.*)$/;
const ROOT_EXEMPTIONS = new Set([
  '.gitattributes',
  '.gitignore',
  'CONTRIBUTING.md',
  'EXIF.md',
  'GUIDE.md',
  'LICENSE',
  'README.md',
  'Q&A.md',
]);

const CHECK_COMMENT_MARKER = '<!-- check-pr-content -->';
const NOTIFY_MARKER = '<!-- maintainer-notify -->';
const MAX_CHECK_COMMENTS = 3;

function safeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]/g, ' ')
    .replace(/@/g, '&#64;')
    .replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function safePath(value) {
  return `\`${String(value).replace(/[\r\n]/g, ' ').replace(/@/g, '&#64;').replace(/`/g, '&#96;')}\``;
}

async function listChangedFiles(github, owner, repo, pr) {
  const files = [];
  let page = 1;
  while (true) {
    const compare = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
      per_page: 100,
      page,
    });
    const pageFiles = compare.data.files || [];
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
    page++;
  }
  return files;
}

function expectedBucket(folderName) {
  const first = folderName.trim().charAt(0);
  return /^[A-Za-z]$/.test(first) ? first.toUpperCase() : '#';
}

function checkFolderPlacement(changedFiles) {
  const invalid = [];
  for (const fileInfo of changedFiles) {
    if (!ACTIVE_STATUSES.has(fileInfo.status)) continue;

    const file = fileInfo.filename.replace(/\\/g, '/');
    const parts = file.split('/').filter(Boolean);
    if (parts[0] === '.github') continue;
    if (parts.length === 1 && ROOT_EXEMPTIONS.has(parts[0])) continue;

    if (parts.length < 3) {
      invalid.push(`- ${safePath(file)}（文件应位于 A-Z/# 下的个人文件夹内）`);
      continue;
    }

    const actualBucket = parts[0];
    const contributorFolder = parts[1];
    const expected = expectedBucket(contributorFolder);
    if (actualBucket !== expected) {
      invalid.push(`- ${safePath(file)}（应位于 ${expected}/${safeText(contributorFolder)}/...）`);
    }
  }
  return invalid;
}

function scanChecklist(text) {
  const unchecked = [];
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(CHECKBOX_RE);
    if (!match) continue;
    total++;
    if (match[1] === ' ') {
      const label = (match[2] || '').trim() || '(untitled item)';
      unchecked.push(`- ${safeText(label)}`);
    }
  }
  return { total, unchecked };
}

async function analyze(github, owner, repo, pr, core) {
  const body = pr.body || '';
  const typeMatch = body.match(PR_TYPE_RE);
  const prTypeMissing = !typeMatch;
  const prType = typeMatch ? typeMatch[1] : 'images';
  const sections = [];
  let failed = false;

  const { total: checklistTotal, unchecked } = scanChecklist(body);
  if (checklistTotal === 0) {
    failed = true;
    sections.push([
      '我们未在 PR 描述中找到自查清单, 请使用仓库提供的 Pull Request 模板, 勿删除清单项:',
      'We could not find a checklist in the PR body. Please use the repository Pull Request template and do not remove the checklist items.',
    ].join('\n'));
  } else if (unchecked.length > 0) {
    failed = true;
    sections.push([
      '我们注意到 PR 模板中的自查清单尚未全部勾选, 请确认并勾选后再次提交:',
      'We noticed that the PR template checklist is incomplete. Please check all items and update the PR:',
      '',
      ...unchecked,
    ].join('\n'));
  }

  const changedFiles = await listChangedFiles(github, owner, repo, pr);
  if (prType === 'images') {
    const images = changedFiles.filter(file =>
      ACTIVE_STATUSES.has(file.status) && IMAGE_EXT.test(file.filename)
    );

    if (images.length === 0) {
      failed = true;
      if (prTypeMissing) {
        sections.push([
          'PR 描述中未找到 pr-type 标签, 已按图片提交 (images) 处理; 但未检测到任何图片文件变更.',
          'No pr-type tag was found in the PR body, so it was treated as an image submission (images); no changed image files were detected.',
          '',
          '若本次不是提交照片, 请关闭后改用正确的 PR 模板 (CI / 文档 / 其他).',
          'If this PR is not for photos, please close it and reopen with the correct template (CI / docs / others).',
          '',
          '若确为图片提交, 请将图片放入对应目录后再 push.',
          'If this is a photo submission, please add images under the proper folders and push again.',
        ].join('\n'));
      } else {
        sections.push([
          '当前 PR 类型为图片提交 (pr-type: images), 但未检测到任何图片文件变更.',
          'This PR is typed as an image submission (pr-type: images), but no changed image files were detected.',
          '',
          '若本次不是提交照片, 请关闭后改用正确的 PR 模板 (CI / 文档 / 其他).',
          'If this PR is not for photos, please close it and reopen with the correct template (CI / docs / others).',
          '',
          '若确为图片提交, 请将图片放入对应目录后再 push.',
          'If this is a photo submission, please add images under the proper folders and push again.',
        ].join('\n'));
      }
    }

    const invalidFolders = checkFolderPlacement(changedFiles);
    if (invalidFolders.length > 0) {
      failed = true;
      sections.push([
        '我们注意到以下文件的目录归类不正确, 请调整路径后再次推送:',
        'We noticed that the following files are not under the correct A-Z/# folder. Please fix the paths and push again:',
        '',
        ...invalidFolders,
        '',
        '正确示例 / Examples:',
        '- M/moe/photo.jpg',
        '- #/233/photo.jpg',
      ].join('\n'));
    }
  } else if (prType === 'ci_wf') {
    const outside = changedFiles
      .filter(file => ACTIVE_STATUSES.has(file.status))
      .map(file => file.filename.replace(/\\/g, '/'))
      .filter(file => !file.startsWith('.github/') && file !== '.github');

    if (outside.length > 0) {
      failed = true;
      sections.push([
        '当前 PR 类型为 CI / 工作流修改 (pr-type: ci_wf), 但检测到 `.github/` 目录之外的文件变更:',
        'This PR is typed as a CI / workflow change (pr-type: ci_wf), but files outside `.github/` were changed:',
        '',
        ...outside.map(file => `- ${safePath(file)}`),
        '',
        '请将非 CI 改动拆到其他 PR, 或改用对应模板 (图片 / 文档 / 其他).',
        'Please split non-CI changes into another PR, or switch to the matching template (images / docs / others).',
      ].join('\n'));
    }
  } else if (prType === 'docs' || prType === 'others') {
    core.info(`pr-type is "${prType}", only checklist rules apply.`);
  } else {
    failed = true;
    sections.push([
      `未识别的 pr-type: "${safeText(prType)}". 请使用模板中的 images / ci_wf / docs / others.`,
      `Unrecognized pr-type: "${safeText(prType)}". Please use images / ci_wf / docs / others from the templates.`,
    ].join('\n'));
  }

  return { sections, failed };
}

async function listMarkedComments(github, owner, repo, prNumber, marker) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return comments.filter(comment =>
    comment.user && comment.user.login === 'github-actions[bot]' &&
    comment.body && comment.body.includes(marker)
  ).length;
}

async function readMaintainers(github, owner, repo, core) {
  try {
    const repository = await github.rest.repos.get({ owner, repo });
    const { data } = await github.rest.repos.getContent({
      owner,
      repo,
      path: '.github/MAINTAINERS.yml',
      ref: repository.data.default_branch,
    });
    const text = Buffer.from(data.content, 'base64').toString('utf-8');
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+@?([A-Za-z0-9-]+)\s*$/);
      if (match) list.push(match[1]);
    }
    return list;
  } catch (error) {
    core.warning(`Cannot read MAINTAINERS.yml: ${error.message}`);
    return [];
  }
}

async function run({ github, context, core, mode }) {
  const { owner, repo } = context.repo;
  let pr;

  if (mode === 'check' && context.eventName === 'pull_request') {
    pr = context.payload.pull_request;
  } else if (mode === 'comment' && context.eventName === 'workflow_run') {
    const run = context.payload.workflow_run;
    if (run.event !== 'pull_request' || run.conclusion !== 'failure') return;
    pr = await resolveWorkflowRunPR(
      github,
      owner,
      repo,
      run,
      '.github/workflows/check_pr_content.yml'
    );
  } else {
    core.setFailed(`Unsupported PR content mode/event: ${mode}/${context.eventName}`);
    return;
  }

  if (!pr) {
    core.info('No current open pull request matches this run.');
    return;
  }

  const result = await analyze(github, owner, repo, pr, core);
  if (mode === 'check') {
    if (result.sections.length > 0) core.info(result.sections.join('\n\n---\n\n'));
    if (result.failed) core.setFailed('PR content check failed.');
    else core.info('PR content check passed.');
    return;
  }

  if (result.sections.length === 0) {
    core.info('The current pull request passes; no comment is needed.');
    return;
  }

  const latest = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (
    latest.data.state !== 'open' ||
    latest.data.head.sha !== pr.head.sha ||
    latest.data.base.sha !== pr.base.sha ||
    latest.data.body !== pr.body
  ) {
    core.info('Pull request changed during inspection; no comment posted.');
    return;
  }

  const checkCount = await listMarkedComments(github, owner, repo, pr.number, CHECK_COMMENT_MARKER);
  const notified = await listMarkedComments(github, owner, repo, pr.number, NOTIFY_MARKER);
  core.info(`check comments: ${checkCount}/${MAX_CHECK_COMMENTS}, notified: ${notified > 0}`);

  if (notified > 0) {
    core.info('Maintainer already notified; no further comments will be posted.');
    return;
  }

  if (checkCount < MAX_CHECK_COMMENTS) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: [result.sections.join('\n\n---\n\n'), '', CHECK_COMMENT_MARKER].join('\n'),
    });
    return;
  }

  const maintainers = await readMaintainers(github, owner, repo, core);
  const mentions = maintainers.length
    ? maintainers.map(name => `@${name}`).join(' ')
    : '(MAINTAINERS.yml 中暂无维护者)';
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: [
      '该 PR 已连续多次未通过内容检查, 请维护者人工处理:',
      'This PR has repeatedly failed the content check. Please have a maintainer review it manually:',
      '',
      mentions,
      '',
      '在维护者处理前, 本检查将不再自动评论.',
      'This check will stay silent until a maintainer takes over.',
      '',
      NOTIFY_MARKER,
    ].join('\n'),
  });
}

module.exports = { run };
