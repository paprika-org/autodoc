import * as core from '@actions/core';
import * as github from '@actions/github';
import OpenAI from 'openai';

const MAX_DIFF_CHARS = 12000;

interface DocResult {
  pr_summary?: string;
  adr_draft?: string;
  onboarding_update?: string;
}

async function getPrDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  });
  const diff = data as unknown as string;
  return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)' : diff;
}

async function getPrContext(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<{ title: string; body: string; baseBranch: string; headBranch: string; changedFiles: number; additions: number; deletions: number }> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return {
    title: pr.title,
    body: pr.body ?? '',
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

async function generateDocs(
  openai: OpenAI,
  diff: string,
  ctx: Awaited<ReturnType<typeof getPrContext>>,
  docTypes: string[]
): Promise<DocResult> {
  const result: DocResult = {};

  if (docTypes.includes('pr_summary')) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are AutoDoc, a documentation assistant. You generate concise, factual PR summaries for engineering teams.
Your output is markdown. Be specific about WHAT changed and WHY (based on the diff).
Do not speculate beyond what the code shows. No filler. Max 300 words.`,
        },
        {
          role: 'user',
          content: `Generate a PR summary for:

PR Title: ${ctx.title}
Branch: ${ctx.headBranch} → ${ctx.baseBranch}
Changed files: ${ctx.changedFiles} (+${ctx.additions}/-${ctx.deletions})
PR Description: ${ctx.body || '(none)'}

Diff:
\`\`\`diff
${diff}
\`\`\`

Output format:
## What changed
(bullet points of specific changes)

## Why (if discernible from diff/description)
(brief rationale)

## Testing notes
(what reviewers should verify)`,
        },
      ],
      max_tokens: 500,
    });
    result.pr_summary = completion.choices[0].message.content ?? '';
  }

  if (docTypes.includes('adr')) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are AutoDoc. You identify architectural decisions in code changes and draft ADRs (Architecture Decision Records) in the MADR format.
Only generate an ADR if the diff contains a genuine architectural decision (new pattern, library choice, schema change, API contract change, significant refactor).
If no architectural decision is present, output exactly: "NO_ADR_NEEDED"`,
        },
        {
          role: 'user',
          content: `PR Title: ${ctx.title}
Branch: ${ctx.headBranch} → ${ctx.baseBranch}

Diff:
\`\`\`diff
${diff}
\`\`\`

Draft an ADR if warranted, or output "NO_ADR_NEEDED".

ADR format:
# ADR-DRAFT: [short title]

## Status
Draft

## Context
[what problem does this decision address]

## Decision
[what was decided]

## Consequences
[what are the trade-offs]`,
        },
      ],
      max_tokens: 600,
    });
    const adr = completion.choices[0].message.content ?? '';
    if (!adr.trim().startsWith('NO_ADR_NEEDED')) {
      result.adr_draft = adr;
    }
  }

  if (docTypes.includes('onboarding')) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are AutoDoc. You maintain onboarding documentation.
Given a PR diff, identify if any new concepts, patterns, or entry points were added that a new engineer should know about.
If nothing onboarding-relevant, output "NO_ONBOARDING_NEEDED". Otherwise write a brief update (max 150 words) suitable for an onboarding guide.`,
        },
        {
          role: 'user',
          content: `PR Title: ${ctx.title}

Diff:
\`\`\`diff
${diff}
\`\`\``,
        },
      ],
      max_tokens: 300,
    });
    const onboarding = completion.choices[0].message.content ?? '';
    if (!onboarding.trim().startsWith('NO_ONBOARDING_NEEDED')) {
      result.onboarding_update = onboarding;
    }
  }

  return result;
}

function buildComment(docs: DocResult, prNumber: number): string {
  const sections: string[] = ['<!-- autodoc-generated -->'];
  sections.push('## 📄 AutoDoc — Generated Documentation\n');

  if (docs.pr_summary) {
    sections.push(docs.pr_summary);
  }

  if (docs.adr_draft) {
    sections.push('\n---\n');
    sections.push('### 🏛 Architecture Decision Record (draft)\n');
    sections.push(docs.adr_draft);
  }

  if (docs.onboarding_update) {
    sections.push('\n---\n');
    sections.push('### 🚀 Onboarding Note\n');
    sections.push(docs.onboarding_update);
  }

  sections.push('\n---\n_Generated by [AutoDoc](https://github.com/paprika-org/autodoc) · [Paprika Labs](https://paprika-org.github.io/autodoc)_');

  return sections.join('\n');
}

async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: pullNumber });
  const existing = comments.find((c) => c.body?.includes('<!-- autodoc-generated -->'));

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`Updated existing AutoDoc comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    core.info(`Created AutoDoc comment on PR #${pullNumber}`);
  }
}

async function commitDocs(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string,
  prNumber: number,
  docs: DocResult
): Promise<void> {
  const files: Array<{ path: string; content: string }> = [];

  if (docs.pr_summary) {
    files.push({ path: `docs/autodoc/pr-${prNumber}-summary.md`, content: `# PR #${prNumber} Summary\n\n${docs.pr_summary}` });
  }
  if (docs.adr_draft) {
    files.push({ path: `docs/autodoc/adr-pr-${prNumber}-draft.md`, content: docs.adr_draft });
  }
  if (docs.onboarding_update) {
    files.push({ path: `docs/autodoc/onboarding-update-pr-${prNumber}.md`, content: docs.onboarding_update });
  }

  for (const file of files) {
    try {
      let sha: string | undefined;
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file.path, ref: branch });
        if ('sha' in data) sha = data.sha;
      } catch {
        // file doesn't exist yet, that's fine
      }

      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: file.path,
        message: `docs(autodoc): auto-generated docs for PR #${prNumber} [skip ci]`,
        content: Buffer.from(file.content).toString('base64'),
        branch,
        sha,
      });
      core.info(`Committed ${file.path}`);
    } catch (err) {
      core.warning(`Failed to commit ${file.path}: ${err}`);
    }
  }
}

async function run(): Promise<void> {
  try {
    const openaiKey = core.getInput('openai_api_key', { required: true });
    const githubToken = core.getInput('github_token', { required: true });
    const docTypesInput = core.getInput('doc_types') || 'pr_summary,adr';
    const postComment = core.getInput('post_comment') !== 'false';
    const commitDocsFlag = core.getInput('commit_docs') === 'true';

    const docTypes = docTypesInput.split(',').map((s) => s.trim());
    const { context } = github;
    const payload = context.payload;

    if (!payload.pull_request) {
      core.info('No pull_request in payload — skipping.');
      return;
    }

    const pullNumber = payload.pull_request.number as number;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    core.info(`AutoDoc running for PR #${pullNumber} in ${owner}/${repo}`);

    const octokit = github.getOctokit(githubToken);
    const openai = new OpenAI({ apiKey: openaiKey });

    core.info('Fetching PR diff and context...');
    const [diff, ctx] = await Promise.all([
      getPrDiff(octokit, owner, repo, pullNumber),
      getPrContext(octokit, owner, repo, pullNumber),
    ]);

    core.info(`Diff: ${diff.length} chars. Files: ${ctx.changedFiles}. Generating ${docTypes.join(', ')}...`);

    const docs = await generateDocs(openai, diff, ctx, docTypes);

    // Set outputs
    if (docs.pr_summary) core.setOutput('pr_summary', docs.pr_summary);
    if (docs.adr_draft) core.setOutput('adr_draft', docs.adr_draft);
    if (docs.onboarding_update) core.setOutput('onboarding_update', docs.onboarding_update);

    if (postComment) {
      const comment = buildComment(docs, pullNumber);
      await upsertComment(octokit, owner, repo, pullNumber, comment);
    }

    if (commitDocsFlag) {
      const branch = payload.pull_request.head.ref as string;
      await commitDocs(octokit, owner, repo, branch, pullNumber, docs);
    }

    core.info('AutoDoc complete.');
  } catch (error) {
    core.setFailed(`AutoDoc failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

run();
