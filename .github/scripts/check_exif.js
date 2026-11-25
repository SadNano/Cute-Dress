const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWorkflowRunPR } = require('./workflow_run_pr');

const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|tiff?|hei[cf]|avif|gif|bmp)$/i;
const ACTIVE_STATUSES = new Set(['added', 'modified', 'renamed', 'copied']);
const PR_TYPE_RE = /<!--\s*pr-type:\s*(\S+)\s*-->/;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const HIGH_SENS_ARGS = [
  '-GPS:GPSLatitude', '-GPS:GPSLongitude', '-GPS:GPSAltitude',
  '-GPS:GPSDateStamp', '-GPS:GPSTimeStamp',
  '-GPS:GPSSpeed', '-GPS:GPSTrack', '-GPS:GPSImgDirection',
  '-IPTC:City', '-IPTC:Country-PrimaryLocationName',
  '-IPTC:Sub-location', '-IPTC:Province-State',
  '-XMP-photoshop:City', '-XMP-photoshop:Country', '-XMP-photoshop:State',
  '-XMP-iptcCore:CreatorWorkEmail', '-XMP-iptcCore:CreatorWorkTelephone',
  '-XMP-iptcCore:CreatorCity', '-XMP-iptcCore:CreatorCountry',
  '-XMP-iptcCore:CreatorPostalCode',
];
const COMMENT_MARKER = '<!-- check-exif -->';

function rawFileUrl(owner, repo, sha, file) {
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${encodedPath}`;
}

async function downloadImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download returned ${response.status}`);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES}-byte EXIF scan limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function listChangedImages(github, owner, repo, pr) {
  const files = [];
  let page = 1;
  while (true) {
    const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
      per_page: 100,
      page,
    });
    const pageFiles = compare.files || [];
    files.push(...pageFiles.filter(file =>
      ACTIVE_STATUSES.has(file.status) && IMAGE_EXT.test(file.filename)
    ));
    if (pageFiles.length < 100) break;
    page++;
  }
  return files;
}

async function scanPullRequest(github, owner, repo, pr, core) {
  const typeMatch = (pr.body || '').match(PR_TYPE_RE);
  const prType = typeMatch ? typeMatch[1] : 'images';
  if (prType !== 'images') {
    core.info(`pr-type is "${prType}", skip EXIF check.`);
    return { sensitive: [], errors: [] };
  }

  if (!pr.head.repo || !pr.head.repo.owner) {
    return { sensitive: [], errors: ['PR head repository is unavailable.'] };
  }

  const changedImages = await listChangedImages(github, owner, repo, pr);
  if (changedImages.length === 0) {
    core.info('No changed images found, skip EXIF check.');
    return { sensitive: [], errors: [] };
  }

  core.info(`Checking ${changedImages.length} image(s) for high-sensitivity EXIF.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exif-'));
  const sensitive = [];
  const errors = [];
  try {
    for (let index = 0; index < changedImages.length; index++) {
      const file = changedImages[index];
      const tmpFile = path.join(tmp, `${index}.image`);
      try {
        const bytes = await downloadImage(rawFileUrl(
          pr.head.repo.owner.login,
          pr.head.repo.name,
          pr.head.sha,
          file.filename
        ));
        fs.writeFileSync(tmpFile, bytes);
        const output = execFileSync('exiftool', [
          ...HIGH_SENS_ARGS,
          '-S',
          '-q',
          '--',
          tmpFile,
        ], { encoding: 'utf-8', timeout: 10_000 });
        const count = output.split(/\r?\n/).filter(line =>
          line && !/: *(undef|00:00:00)?$/.test(line)
        ).length;
        if (count > 0) {
          sensitive.push(file.filename);
          core.info(`Sensitive EXIF found: ${file.filename} (${count} tags)`);
        }
      } catch (error) {
        errors.push(`${file.filename}: ${error.message}`);
        core.warning(`Unable to inspect ${file.filename}: ${error.message}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  } finally {
    try { fs.rmdirSync(tmp); } catch {}
  }
  return { sensitive, errors };
}

async function findExistingComment(github, owner, repo, prNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return comments.find(comment =>
    comment.user && comment.user.login === 'github-actions[bot]' &&
    comment.body && comment.body.includes(COMMENT_MARKER)
  );
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
      '.github/workflows/check_exif.yml'
    );
  } else {
    core.setFailed(`Unsupported EXIF mode/event: ${mode}/${context.eventName}`);
    return;
  }

  if (!pr) {
    core.info('No current open pull request matches this run.');
    return;
  }

  if (mode === 'check') {
    const result = await scanPullRequest(github, owner, repo, pr, core);
    if (result.sensitive.length > 0) core.setFailed('High-sensitivity EXIF data detected.');
    if (result.errors.length > 0) core.setFailed(`Unable to inspect ${result.errors.length} image(s).`);
    if (result.sensitive.length === 0 && result.errors.length === 0) {
      core.info('No high-sensitivity EXIF data found.');
    }
    return;
  }

  const typeMatch = (pr.body || '').match(PR_TYPE_RE);
  const prType = typeMatch ? typeMatch[1] : 'images';
  if (prType !== 'images') return;

  const latest = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (
    latest.data.state !== 'open' ||
    latest.data.head.sha !== pr.head.sha ||
    latest.data.body !== pr.body
  ) {
    core.info('Pull request changed during inspection; no comment posted.');
    return;
  }

  const runUrl = context.payload.workflow_run.html_url;
  const body = [
    '图片 EXIF 检查未通过或无法完成。请查看检查运行详情，移除高敏感 EXIF 信息，或确认图片能够正常读取后重新提交。',
    'The image EXIF check failed or could not complete. Review the check run, remove high-sensitivity EXIF data, or ensure the image can be read, then push again.',
    '',
    `[Check run / 检查运行](${runUrl})`,
    '',
    '温馨提示: 可以使用 `/auto-fix` 移除全部 EXIF 信息。',
    'You can use `/auto-fix` to remove all EXIF metadata.',
    '',
    COMMENT_MARKER,
  ].join('\n');
  const existing = await findExistingComment(github, owner, repo, pr.number);
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body,
    });
  }
}

module.exports = { run };
