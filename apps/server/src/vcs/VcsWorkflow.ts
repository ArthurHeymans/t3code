import type * as Effect from "effect/Effect";
import type {
  GitCommandError,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsPullResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import type { GitCommitProgress, GitPushResult, GitVcsDriver } from "./GitVcsDriver.ts";
/** Only the ref/workspace operations exposed by the app, not the Git command service. */
export type VcsRefOperations = Pick<
  GitVcsDriver["Service"],
  | "listRefs"
  | "createWorktree"
  | "listLocalBranchNames"
  | "fetchRemote"
  | "remoteExists"
  | "remoteBranchExists"
  | "resolveRemoteTrackingCommit"
  | "removeWorktree"
  | "deleteLocalBranch"
  | "createRef"
  | "renameBranch"
> & {
  readonly validateWorktreePath: (input: {
    readonly cwd: string;
    readonly path: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly recoverWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly refName: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
};

/** A working revision is independent of the named ref used to publish it. */
export interface PublicationRef {
  readonly name: string;
  readonly remoteName: string | null;
  readonly remoteRef: string | null;
}

export interface RefContext {
  readonly exists: boolean;
  readonly publication: PublicationRef;
}

export interface RepositoryState {
  readonly local: VcsStatusLocalResult;
  readonly publication: PublicationRef | null;
  readonly defaultRef: string | null;
  readonly remote: Omit<VcsStatusRemoteResult, "pr">;
}

/** Backend operations used by shared commit/publish/hosting orchestration. */
export interface VcsWorkflow {
  readonly kind: "git" | "jj";
  readonly refs: VcsRefOperations;
  readonly template: (
    cwd: string,
    revision: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  /** Native review preparation where host checkout helpers cannot be used. */
  readonly reviewWorkspace?: (input: {
    readonly cwd: string;
    readonly headRef: string;
    readonly localRef: string;
    readonly remoteUrl: string | null;
    readonly newRemoteName: string;
    readonly destination: string | null;
    readonly reuse: boolean;
  }) => Effect.Effect<
    {
      readonly branch: string;
      readonly worktreePath: string | null;
      readonly isOnPullRequestHead: boolean;
    },
    GitCommandError
  >;
  readonly state: (
    cwd: string,
    options?: {
      readonly localOnly?: boolean;
      readonly remoteOnly?: boolean;
      readonly refreshUpstream?: boolean;
    },
  ) => Effect.Effect<RepositoryState, GitCommandError>;
  /** Native ref metadata: Git's configured upstream or JJ's selected remote bookmark. */
  readonly refContext: (cwd: string, refName: string) => Effect.Effect<RefContext, GitCommandError>;
  /** Cheap routing hint, also used for best-effort hosting labels. */
  readonly publicationRemote: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  /** Cold PR lookup only. No local evidence is different from known unpublished. */
  readonly probePublication: (
    cwd: string,
    refName: string,
    preferredRemote?: string | null,
  ) => Effect.Effect<
    { readonly remoteName: string | null; readonly published: boolean | null },
    GitCommandError
  >;
  readonly prBaseRef: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly remoteUrl: (
    cwd: string,
    remoteName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly primaryRemote: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly defaultRef: (
    cwd: string,
    remoteName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly remoteRevision: (
    cwd: string,
    refName: string,
    remoteName: string,
  ) => Effect.Effect<string, GitCommandError>;
  readonly recentSubjects: (cwd: string) => Effect.Effect<readonly string[], GitCommandError>;
  readonly prepareCommit: (
    cwd: string,
    paths?: readonly string[],
  ) => Effect.Effect<{ readonly summary: string; readonly patch: string } | null, GitCommandError>;
  readonly recordCommit: (input: {
    readonly cwd: string;
    readonly subject: string;
    readonly body: string;
    readonly publicationRef: string | null;
    readonly confirmedDefaultRef: boolean;
    readonly paths?: readonly string[];
    readonly timeoutMs?: number;
    readonly progress?: GitCommitProgress;
  }) => Effect.Effect<{ readonly commitSha: string }, GitCommandError>;
  readonly publish: (
    cwd: string,
    refName: string | null,
    options?: { readonly remoteName?: string },
  ) => Effect.Effect<GitPushResult, GitCommandError>;
  readonly fetch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly range: (
    cwd: string,
    baseRevision: string,
  ) => Effect.Effect<
    { readonly commitSummary: string; readonly diffSummary: string; readonly diffPatch: string },
    GitCommandError
  >;
  readonly createFeatureRef: (
    cwd: string,
    preferredName: string,
  ) => Effect.Effect<string, GitCommandError>;
}
