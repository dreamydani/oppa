import React, { useEffect, useState } from "react";
import { ExternalLink, Loader2, Sparkles, AlertCircle, GitPullRequest } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../store/terminalStore";
import { generatePrMessage, onGitChanged } from "../../lib/git/transport";
import type { BlockedReason } from "../../lib/git/transport";

// Shared with the worktree Finish action so blocked reasons speak identically
// on every surface that can trigger a review.
export const BLOCKED_COPY: Record<BlockedReason, string> = {
  "detached-head": "Checkout a branch first.",
  "unsupported-provider": "This repository is not on GitHub.",
  "gh-missing": "Install gh CLI.",
  "gh-not-authed": "Run gh auth login.",
  "auth-required": "Run gh auth login.",
  "default-branch": "Switch to your feature branch.",
  "dirty": "Commit or stash changes first.",
  "no-upstream": "Push your branch first.",
  "needs-sync": "Pull upstream first.",
  "needs-push": "Push your changes first.",
  "base-not-on-remote": "Push the base branch first.",
  "existing-review": "Pull request already exists.",
};

const BLOCKED_HINT: Record<BlockedReason, string> = {
  "detached-head": "git checkout -b <branch>",
  "unsupported-provider": "Set origin to a GitHub remote.",
  "gh-missing": "https://cli.github.com/",
  "gh-not-authed": "gh auth login",
  "auth-required": "gh auth login",
  "default-branch": "Create and checkout a feature branch.",
  "dirty": "git commit or git stash",
  "no-upstream": "git push -u origin HEAD",
  "needs-sync": "git pull or Fetch + Pull",
  "needs-push": "git push",
  "base-not-on-remote": "git push origin <base>",
  "existing-review": "",
};

function isStackedBase(
  baseRef: string | null | undefined,
  worktrees: { record: { branch: string } }[],
): string | null {
  if (!baseRef || baseRef === "main" || baseRef === "master") return null;
  const match = worktrees.find((w) => w.record.branch === baseRef);
  return match ? baseRef : null;
}

export function ReviewComposer(): React.ReactElement | null {
  const cwd = useTerminalStore((s) => s.getActiveCwd());
  const reviewEntry = useTerminalStore((s) => (cwd ? s.reviewByCwd[cwd] : undefined));
  const refreshReviewEligibility = useTerminalStore((s) => s.refreshReviewEligibility);
  const createReview = useTerminalStore((s) => s.createReview);
  const worktrees = useTerminalStore((s) => s.worktrees);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Eligibility probe on mount / cwd change / git-changed debounce
  useEffect(() => {
    if (!cwd) return;
    void refreshReviewEligibility(cwd);
  }, [cwd, refreshReviewEligibility]);

  useEffect(() => {
    if (!cwd) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    void onGitChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshReviewEligibility(cwd);
      }, 300);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
    };
  }, [cwd, refreshReviewEligibility]);

  // Reset form when cwd changes to a different eligibility
  useEffect(() => {
    setTitle("");
    setBody("");
    setDraft(false);
    setError(null);
    setAiError(null);
  }, [cwd]);

  if (!cwd) return null;

  const loading = reviewEntry?.loading ?? false;
  const eligibility = reviewEntry?.eligibility;

  if (loading && !eligibility) {
    return (
      <div className="review-composer review-composer-loading" data-testid="review-loading">
        <Loader2 size={14} className="git-ai-spinner" />
        <span>Checking pull request eligibility…</span>
      </div>
    );
  }

  if (!eligibility) {
    return null;
  }

  // Existing PR link state
  if (eligibility.eligible && eligibility.existing_pr_url) {
    const url = eligibility.existing_pr_url;
    const handleOpen = () => {
      openUrl(url).catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
    };
    return (
      <div className="review-composer review-composer-existing" data-testid="review-existing">
        <div className="review-existing-header">
          <GitPullRequest size={14} />
          <span>Pull request exists</span>
        </div>
        <button type="button" className="review-open-link" data-testid="open-pr-link" onClick={handleOpen}>
          <ExternalLink size={12} />
          Open PR
        </button>
        <div className="review-existing-url" title={url}>
          {url}
        </div>
      </div>
    );
  }

  // Eligible composer form
  if (eligibility.eligible && !eligibility.existing_pr_url) {
    const stackedOn = isStackedBase(eligibility.base_ref, worktrees);
    const handleGenerate = () => {
      if (!cwd || generating) return;
      setGenerating(true);
      setAiError(null);
      void (async () => {
        try {
          const msg = await generatePrMessage(cwd);
          setTitle(msg.title.slice(0, 200));
          setBody(msg.body);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          setAiError(text);
        } finally {
          setGenerating(false);
        }
      })();
    };

    const handleCreate = () => {
      if (!cwd || creating || !title.trim()) return;
      setCreating(true);
      setError(null);
      void (async () => {
        try {
          await createReview(cwd, { title: title.trim(), body, draft });
          // Store thunk refreshes eligibility; keep form values until refresh shows linked state
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          setError(text);
        } finally {
          setCreating(false);
        }
      })();
    };

    return (
      <div className="review-composer" data-testid="review-composer">
        <div className="review-composer-header">
          <GitPullRequest size={14} />
          <span>Create Pull Request</span>
          {eligibility.base_ref && (
            <span className="review-base-badge" title={`base ${eligibility.base_ref}`}>
              → {eligibility.base_ref}
            </span>
          )}
          {stackedOn && (
            <span className="review-stacked-chip" data-testid="stacked-chip" title={`stacked onto ${stackedOn}`}>
              stacked onto {stackedOn}
            </span>
          )}
        </div>
        <input
          type="text"
          className="review-title-input"
          placeholder="Brief title"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="review-title-input"
        />
        <textarea
          className="review-body-input"
          placeholder="Describe the change..."
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          data-testid="review-body-input"
        />
        <label className="review-draft-label">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            data-testid="review-draft-checkbox"
          />
          Create as draft
        </label>
        {aiError && (
          <div className="git-status-line error" data-testid="review-ai-error">
            {aiError}
          </div>
        )}
        {error && (
          <div className="git-status-line error" data-testid="review-create-error">
            {error}
          </div>
        )}
        <div className="review-composer-actions">
          <button
            type="button"
            className="git-commit-ai-btn"
            disabled={generating || creating}
            title="Generate title and body from branch diff"
            onClick={handleGenerate}
            data-testid="review-ai-btn"
          >
            {generating ? (
              <>
                <Loader2 size={12} className="git-ai-spinner" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles size={12} />
                AI Generate
              </>
            )}
          </button>
          <button
            type="button"
            className="git-commit-btn"
            disabled={!title.trim() || generating || creating}
            onClick={handleCreate}
            data-testid="review-create-btn"
          >
            {creating ? (
              <>
                <Loader2 size={12} className="git-ai-spinner" />
                Creating…
              </>
            ) : (
              "Create PR"
            )}
          </button>
        </div>
      </div>
    );
  }

  // Blocked state
  const reason = eligibility.blocked_reason as BlockedReason | null;
  const human = reason ? BLOCKED_COPY[reason] ?? "Not eligible." : "Not eligible.";
  const hint = reason ? BLOCKED_HINT[reason] ?? "" : "";
  const kebab = reason ?? "unknown";
  return (
    <div className="review-composer review-composer-blocked" data-testid="review-blocked">
      <div className="review-blocked-row">
        <AlertCircle size={12} className="review-blocked-icon" />
        <span className="review-blocked-msg">{human}</span>
      </div>
      {hint && <div className="review-blocked-hint">{hint}</div>}
      <div className="review-blocked-kebab" title={`blocked_reason: ${kebab}`}>
        blocked: {kebab}
      </div>
    </div>
  );
}
