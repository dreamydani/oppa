import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore } from "./terminalStore";
import * as transport from "../lib/pty/transport";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onPtyCwd: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
  worktreeCreateFleet: vi.fn(),
  diffCommentsList: vi.fn().mockResolvedValue([]),
  diffCommentAdd: vi.fn(),
  diffCommentUpdate: vi.fn(),
  diffCommentDelete: vi.fn().mockResolvedValue(undefined),
  diffCommentsMarkSent: vi.fn(),
}));

const worktreeCreateFleetMock = vi.mocked(transport.worktreeCreateFleet);
const worktreeListMock = vi.mocked(transport.worktreeList);

describe("fleet spawn slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({ isFleetSheetOpen: false, fleetSheetPrefill: null });
  });

  it("spawnFleet forwards the payload to the fleet IPC and refreshes the registry", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [
        { index: 0, ok: true, record: null, session_id: null, error: null },
      ],
    });
    worktreeListMock.mockResolvedValue([]);

    const input = {
      repoPath: "C:/repos/demo",
      baseRef: "develop",
      sharedPrompt: "Fix the login timeout",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    };
    const result = await useTerminalStore.getState().spawnFleet(input);

    expect(worktreeCreateFleetMock).toHaveBeenCalledTimes(1);
    expect(worktreeCreateFleetMock).toHaveBeenCalledWith(input);
    expect(result.results[0]?.ok).toBe(true);
    // Cards must reflect the landed fleet, not stale registry data
    await vi.waitFor(() => {
      expect(worktreeListMock).toHaveBeenCalled();
    });
  });

  it("openFleetSheet opens with prefill and closeFleetSheet closes", () => {
    useTerminalStore.getState().openFleetSheet({
      repoPath: "C:/repos/demo",
      baseRef: "main",
      count: 3,
    });
    expect(useTerminalStore.getState().isFleetSheetOpen).toBe(true);
    expect(useTerminalStore.getState().fleetSheetPrefill).toEqual({
      repoPath: "C:/repos/demo",
      baseRef: "main",
      count: 3,
    });

    useTerminalStore.getState().closeFleetSheet();
    expect(useTerminalStore.getState().isFleetSheetOpen).toBe(false);
  });

  it("openFleetSheet without prefill keeps the prefill field empty", () => {
    useTerminalStore.getState().openFleetSheet();
    expect(useTerminalStore.getState().isFleetSheetOpen).toBe(true);
    expect(useTerminalStore.getState().fleetSheetPrefill).toBeNull();
  });
});
