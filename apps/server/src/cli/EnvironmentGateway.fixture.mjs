import * as NodeReadline from "node:readline";
const lines = NodeReadline.createInterface({ input: process.stdin });
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let hello;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.kind === "hello") {
    hello = message;
    // stderr is deliberately unsafe: the gateway must discard it.
    process.stderr.write(process.env.T3_CLIENT_ACCESS_TOKEN);
    output({
      kind: "ready",
      environmentId: hello.environment.id,
      generation: hello.environment.generation,
    });
  } else if (message.operation === "crash") {
    process.exit(1);
  } else if (message.operation === "leak") {
    output({ kind: "fatal", message: process.env.T3_CLIENT_ACCESS_TOKEN });
  } else {
    output({
      kind: "response",
      id: message.id,
      result: {
        authenticated:
          process.env.T3_CLIENT_ACCESS_TOKEN ===
          `credential-${hello.environment.endpoint.includes("remote-a") ? "a" : "b"}`,
        endpoint: hello.environment.endpoint,
        secretInArgv: process.argv.some((arg) => arg.includes(process.env.T3_CLIENT_ACCESS_TOKEN)),
      },
    });
  }
}
