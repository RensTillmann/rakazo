import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** How the stub answers `maintenance_validate`: allow, deny with a reason, or answer late. */
export type FleetAuthorityAnswer =
  | { allowed: true; delayMs?: number }
  | { allowed: false; reason: string; delayMs?: number };

export interface FleetAuthorityCall {
  runId: string;
  /** The `X-Rakazo-Invocation-Id` the call carried. */
  invocationId: string;
}

type JsonRpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * A scripted stand-in for the Fleet service's maintenance authority: a streamable-HTTP MCP server
 * with one read-only tool, `maintenance_validate { run_id }`, answering `{ allowed, reason? }` as
 * the real service does. It requires the configured bearer on every request and an
 * `X-Rakazo-Invocation-Id` on each tool call, and records every call it answered.
 */
export class FleetAuthorityStub {
  private server: Server | undefined;
  port = 0;
  answer: FleetAuthorityAnswer = { allowed: true };
  readonly calls: FleetAuthorityCall[] = [];
  /** Requests refused for a missing or wrong bearer or invocation id. */
  refused = 0;

  constructor(readonly token: string) {}

  /** The local URL it listens on; the Rakazo side still addresses `http://fleet-service:8790/mcp`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          if (body === undefined) res.writeHead(status).end();
          else
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        },
        () => res.writeHead(500).end(),
      );
    });
    await once(this.server.listen(0, "127.0.0.1"), "listening");
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    const closed = once(this.server, "close");
    this.server.close();
    await closed;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    if (req.method !== "POST") return { status: 405 };
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      this.refused += 1;
      return { status: 401, body: { error: "unauthorized" } };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpc;
    if (message.id === undefined) return { status: 202 };
    const reply = (result: unknown) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: message.id, result },
    });
    if (message.method === "initialize") {
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fleet-authority-stub", version: "1" },
      });
    }
    if (message.method === "tools/list") {
      return reply({
        tools: [
          {
            name: "maintenance_validate",
            description: "Whether the Fleet still authorizes this exact run to continue.",
            inputSchema: {
              type: "object",
              properties: { run_id: { type: "string" } },
              required: ["run_id"],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    }
    if (message.method === "tools/call") {
      const invocationId = req.headers["x-rakazo-invocation-id"];
      const args = message.params?.arguments as { run_id?: unknown } | undefined;
      if (
        message.params?.name !== "maintenance_validate" ||
        typeof invocationId !== "string" ||
        !invocationId ||
        typeof args?.run_id !== "string"
      ) {
        this.refused += 1;
        return { status: 400, body: { error: "invocation id and run_id required" } };
      }
      const answer = this.answer;
      if (answer.delayMs) await delay(answer.delayMs);
      this.calls.push({ runId: args.run_id, invocationId });
      const verdict = answer.allowed
        ? { allowed: true }
        : { allowed: false, reason: answer.reason };
      return reply({
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        structuredContent: verdict,
      });
    }
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      },
    };
  }
}
