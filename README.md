# AutoDoc

**Pipeline-native AI documentation. PR summaries, ADRs, and onboarding guides — generated automatically, zero engineer input.**

Every time a PR is opened or updated, AutoDoc reads the diff and generates:

- **PR summaries** — what changed and why, ready to share
- **ADR drafts** — architecture decisions captured while the context is fresh
- **Onboarding updates** — keeps new-engineer docs current automatically

---

## Quick start

Add to `.github/workflows/autodoc.yml`:

```yaml
name: AutoDoc

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  autodoc:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: write
    steps:
      - uses: paprika-org/autodoc@v0.1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Add `OPENAI_API_KEY` to your repo secrets. That's it.

---

## Example output

When a PR is opened, AutoDoc posts a comment like this:

> ## 📄 AutoDoc — Generated Documentation
>
> ## What changed
> - Added `RateLimiter` class in `src/middleware/rate-limit.ts` — sliding window, 100 req/min per IP
> - Updated `app.ts` to apply rate limiting before auth middleware
> - Added unit tests covering edge cases at the limit boundary
>
> ## Why
> Addresses production incident #147 — unauthenticated endpoints were vulnerable to scraping.
>
> ## Testing notes
> Verify rate limit headers (`X-RateLimit-Remaining`) are returned on every request.
>
> ---
>
> ### 🏛 Architecture Decision Record (draft)
>
> **ADR-DRAFT: Sliding window rate limiting at middleware layer**
>
> **Status:** Draft
>
> **Context:** Need to protect unauthenticated API endpoints from abuse without per-route configuration.
>
> **Decision:** Implement rate limiting as Express middleware using an in-memory sliding window counter, applied globally before auth.
>
> **Consequences:** Simple to deploy; state is per-instance (won't work across pods without Redis). Acceptable for current single-instance deployment.

---

## Configuration

| Input | Default | Description |
|-------|---------|-------------|
| `openai_api_key` | — | Your OpenAI API key (required) |
| `github_token` | — | `${{ secrets.GITHUB_TOKEN }}` (required) |
| `doc_types` | `pr_summary,adr` | Which docs to generate: `pr_summary`, `adr`, `onboarding` |
| `post_comment` | `true` | Post docs as a PR comment |
| `commit_docs` | `false` | Also commit docs to `docs/autodoc/` in the PR branch |

---

## Pilot program

We're running a **closed pilot** — $300 non-refundable setup, then $39/repo/month.

We onboard one repo, get docs generating in under an hour, and you decide if it's worth keeping. Pilot includes direct access to us for configuration and feedback.

→ **[Request pilot access](mailto:paprika-lab@agentmail.to?subject=AutoDoc%20pilot)**

---

## How it works

1. PR opens or updates → GitHub Action triggers
2. AutoDoc fetches the full diff via GitHub API
3. GPT-4o-mini analyzes the diff and generates structured docs
4. Docs posted as a PR comment (and optionally committed to the branch)
5. Your team reviews, edits, and approves before merging

---

## Built by Paprika Labs

We build focused developer tools. [paprika-lab.bsky.social](https://bsky.app/profile/paprika-lab.bsky.social)
