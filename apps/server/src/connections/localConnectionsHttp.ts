import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  LocalConnectionsEnable,
  LocalConnectionsSync,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as LocalConnections from "./LocalConnections.ts";

const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalConnectionsEnable));

const decodeSync = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalConnectionsSync));

const handle = (operation: "status" | "enable" | "sync" | "revoke") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    if (!LocalConnections.isLocalConnectionsRequest(request, config.devUrl))
      return HttpServerResponse.empty({ status: 403 });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request);
    const scope = operation === "status" ? AuthAccessReadScope : AuthAccessWriteScope;
    if (!session.scopes.includes(scope)) return HttpServerResponse.empty({ status: 403 });
    const catalog = yield* LocalConnections.LocalConnections;
    if (operation === "status")
      return HttpServerResponse.jsonUnsafe(yield* catalog.status, {
        headers: { "Cache-Control": "no-store" },
      });
    if (operation === "revoke") yield* catalog.revoke;
    else {
      const body = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1_200_000)),
      );
      if (Buffer.byteLength(body) > 1_200_000) return HttpServerResponse.empty({ status: 413 });
      if (operation === "enable") {
        const input = yield* decodeWrite(body);
        return HttpServerResponse.jsonUnsafe(
          yield* catalog.replace(input.environments, true, undefined, input.expectedRevision),
          {
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      const input = yield* decodeSync(body);
      yield* catalog.replace(input.environments, false, input.grantId);
    }
    return HttpServerResponse.empty({ status: 204 });
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 403 }))));

export const localConnectionsRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/local-connections", handle("status")),
  HttpRouter.add("PUT", "/api/local-connections", handle("enable")),
  HttpRouter.add("POST", "/api/local-connections", handle("sync")),
  HttpRouter.add("DELETE", "/api/local-connections", handle("revoke")),
);
