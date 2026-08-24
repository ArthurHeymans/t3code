import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { VcsError, VcsListWorkspacesInput, VcsListWorkspacesResult } from "@t3tools/contracts";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsWorkspaceService extends Context.Service<
  VcsWorkspaceService,
  {
    readonly list: (
      input: VcsListWorkspacesInput,
    ) => Effect.Effect<VcsListWorkspacesResult, VcsError>;
    readonly validateJjWorkspacePath: (input: {
      readonly projectCwd: string;
      readonly workspacePath: string;
    }) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsWorkspaceService") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const path = yield* Path.Path;

  const list: VcsWorkspaceService["Service"]["list"] = Effect.fn("VcsWorkspaceService.list")(
    function* (input) {
      const handle = yield* registry.detect({ cwd: input.cwd });
      if (handle === null) {
        return {
          kind: "unknown",
          isRepo: false,
          canCreateWorkspace: false,
          workspaces: [],
        };
      }

      const currentRoot = path.normalize(path.resolve(handle.repository.rootPath));
      const workspaces = yield* handle.driver.listWorkspaces(input.cwd);
      return {
        kind: handle.kind,
        isRepo: true,
        canCreateWorkspace: handle.driver.capabilities.supportsWorktrees,
        workspaces: workspaces.map((workspace) => {
          const workspacePath = path.normalize(path.resolve(workspace.path));
          return {
            ...workspace,
            path: workspacePath,
            current: workspacePath === currentRoot,
          };
        }),
      };
    },
  );

  const validateJjWorkspacePath: VcsWorkspaceService["Service"]["validateJjWorkspacePath"] =
    Effect.fn("VcsWorkspaceService.validateJjWorkspacePath")(function* (input) {
      const inventory = yield* list({ cwd: input.projectCwd });
      if (inventory.kind !== "jj") return;
      const requestedPath = path.normalize(path.resolve(input.workspacePath));
      if (!inventory.workspaces.some((workspace) => workspace.path === requestedPath)) {
        return yield* new VcsRepositoryDetectionError({
          operation: "VcsWorkspaceService.validateJjWorkspacePath",
          cwd: input.projectCwd,
          detail: `The selected Jujutsu workspace is no longer registered: ${requestedPath}`,
        });
      }
    });

  return VcsWorkspaceService.of({ list, validateJjWorkspacePath });
});

export const layer = Layer.effect(VcsWorkspaceService, make);
