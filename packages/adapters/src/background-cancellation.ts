import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export interface BackgroundCancellation {
  signal: AbortSignal;
  stop(): void;
}

/** Observe the same source-run force request for foreground and terminal-run effects. */
export async function watchBackgroundCancellation(
  prisma: PrismaClient,
  runId: string,
  abort?: () => Promise<void>,
): Promise<BackgroundCancellation> {
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const run = await prisma.run.findUnique({
        where: { id: runId }, select: { maintenanceCancelRequestedAt: true },
      });
      if (!run || run.maintenanceCancelRequestedAt) {
        controller.abort(new Error("Background operation cancellation requested"));
        await abort?.();
      }
    } catch (error) {
      controller.abort(error);
      await abort?.();
      throw error;
    } finally {
      checking = false;
    }
  };
  await check();
  const timer = setInterval(() => {
    void check().catch((error) => getLogger().error("background cancellation observation", error));
  }, 2_000);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}
