import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";
import type { TeamChatBridgeDeps } from "./team-chat-bridge.js";
import { TeamChatBridge } from "./team-chat-bridge.js";

/** Complete the persistence seam of the small bridge fixtures, without mocking admission. */
export function createTestBridge(deps: TeamChatBridgeDeps) {
  deps.prisma.$queryRaw ??= vi.fn(async () => [{ active: false, revision: 0 }]) as PrismaClient["$queryRaw"];
  deps.prisma.$transaction ??= vi.fn(async (operation: ((tx: PrismaClient) => Promise<unknown>) | Promise<unknown>[]) =>
    Array.isArray(operation) ? Promise.all(operation) : operation(deps.prisma),
  ) as PrismaClient["$transaction"];
  if (deps.prisma.externalMessage) {
    deps.prisma.externalMessage.findUnique ??= vi.fn(async () => ({ lastError: null })) as unknown as PrismaClient["externalMessage"]["findUnique"];
  }
  return new TeamChatBridge(deps);
}
