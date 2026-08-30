import React, { useEffect } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../store/terminalStore";
import { onGitChanged, onPrChanged } from "../../lib/git/transport";
import type { CheckState } from "../../lib/git/transport";

function stateBadgeClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "merged") return "state-merged";
  if (s === "closed") return "state-closed";
  return "state-open";
}

function checkDotClass(state: CheckState): string {
  switch (state) {
    case "passing":
      return "dot-passing";
    case "failing":
      return "dot-failing";
    case "pending":
      return "dot-pending";
    case "skipping":
      return "dot-skipping";
    default:
      return "dot-pending";
  }
}

function checkDotSymbol(state: CheckState): string {
  return state === "skipping" ? "○" : "●";
}

export function PrChecksCard({ cwd: cwdProp }: { cwd?: string }): React.ReactElement | null {
  const activeCwd = useTerminalStore((s) => s.getActiveCwd());
  const cwd = cwdProp ?? activeCwd;
  const reviewEntry = useTerminalStore((s) => (cwd ? s.reviewByCwd[cwd] : undefined));
  const refreshReviewStatus = useTerminalStore((s) => s.refreshReviewStatus);

  const eligibility = reviewEntry?.eligibility;
  const prStatus = reviewEntry?.prStatus;
  const loading = reviewEntry?.loading ?? false;

  const hasLinked = Boolean(eligibility?.existing_pr_url || prStatus);

  // Initial fetch when linked but no status yet
  useEffect(() => {
    if (!cwd || !hasLinked) return;
    if (!prStatus && !loading) {
      void refreshReviewStatus(cwd);
    }
  }, [cwd, hasLinked, prStatus, loading, refreshReviewStatus]);

  // Refresh on pr-changed / git-changed when linked
  useEffect(() => {
    if (!cwd || !hasLinked) return;
    let unlistenPr: (() => void) | null = null;
    let unlistenGit: (() => void) | null = null;
    let timerPr: ReturnType<typeof setTimeout> | null = null;
    let timerGit: ReturnType<typeof setTimeout> | null = null;
    void onPrChanged(() => {
      if (timerPr) clearTimeout(timerPr);
      timerPr = setTimeout(() => {
        const cur = useTerminalStore.getState().reviewByCwd[cwd];
        if (cur?.eligibility?.existing_pr_url || cur?.prStatus) {
          void refreshReviewStatus(cwd);
        }
      }, 300);
    }).then((fn) => {
      unlistenPr = fn;
    });
    void onGitChanged(() => {
      if (timerGit) clearTimeout(timerGit);
      timerGit = setTimeout(() => {
        const cur = useTerminalStore.getState().reviewByCwd[cwd];
        if (cur?.eligibility?.existing_pr_url || cur?.prStatus) {
          void refreshReviewStatus(cwd);
        }
      }, 300);
    }).then((fn) => {
      unlistenGit = fn;
    });
    return () => {
      if (timerPr) clearTimeout(timerPr);
      if (timerGit) clearTimeout(timerGit);
      if (unlistenPr) unlistenPr();
      if (unlistenGit) unlistenGit();
    };
  }, [cwd, hasLinked, refreshReviewStatus]);

  if (!cwd || !hasLinked) return null;

  if (loading && !prStatus) {
    return (
      <div className="pr-checks-card pr-checks-loading" data-testid="pr-checks-loading">
        <Loader2 size={14} className="git-ai-spinner" />
        <span>Loading PR status…</span>
      </div>
    );
  }

  if (!prStatus) return null;

  const handleOpen = () => {
    const url = prStatus.url;
    if (!url) return;
    openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  const handleRefresh = () => {
    if (!cwd) return;
    void refreshReviewStatus(cwd);
  };

  return (
    <div className="pr-checks-card" data-testid="pr-checks-card">
      <div className="pr-checks-header">
        <div className="pr-checks-title-row">
          <span className="pr-checks-number" data-testid="pr-checks-number">
            #{prStatus.number}
          </span>
          <span className="pr-checks-title" title={prStatus.title} data-testid="pr-checks-title">
            {prStatus.title}
          </span>
        </div>
        <div className="pr-checks-header-meta">
          <span className={`pr-state-badge ${stateBadgeClass(prStatus.state)}`} data-testid="pr-state-badge">
            {prStatus.state}
          </span>
          {prStatus.draft && (
            <span className="pr-draft-chip" data-testid="pr-draft-chip">
              draft
            </span>
          )}
          <button
            type="button"
            className="pr-checks-refresh-btn"
            title="Refresh PR status"
            aria-label="Refresh PR status"
            data-testid="pr-checks-refresh"
            onClick={handleRefresh}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="pr-checks-url-row">
        <button
          type="button"
          className="review-open-link"
          data-testid="open-pr-link-checks"
          onClick={handleOpen}
        >
          <ExternalLink size={12} />
          Open PR ↗
        </button>
        <span className="pr-checks-fetched" data-testid="pr-checks-fetched" title={new Date(prStatus.fetched_at_ms).toLocaleString()}>
          fetched {new Date(prStatus.fetched_at_ms).toLocaleTimeString()}
        </span>
      </div>

      <div className="pr-checks-list" data-testid="pr-checks-list">
        {prStatus.checks.length === 0 ? (
          <div className="pr-checks-empty" data-testid="pr-checks-empty">
            No checks reported
          </div>
        ) : (
          prStatus.checks.map((check, idx) => (
            <div key={`${check.name}:${idx}`} className="pr-check-row" data-testid="pr-check-row">
              <span className={`pr-check-dot ${checkDotClass(check.state)}`} data-testid="pr-check-dot">
                {checkDotSymbol(check.state)}
              </span>
              <span className="pr-check-name" data-testid="pr-check-name">
                {check.name}
              </span>
              <span className="pr-check-state" data-testid="pr-check-state">
                {check.state}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
