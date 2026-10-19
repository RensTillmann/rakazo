import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);
const SEMANTIC_MEMORY_WRITE_TOOL_NAMES = new Set(["save_memory", "forget_memory"]);

/**
 * Native `remember` stays on whether or not a provider is connected (fleet: a bot keeps its own
 * notes). A recall-only provider (`canSave` false) offers `recall_memory` but no save/forget.
 */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  canSave = true,
): ConnectorTool[] {
  if (!semanticMemoryConfigured) {
    return tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
  }
  return canSave ? tools : tools.filter((tool) => !SEMANTIC_MEMORY_WRITE_TOOL_NAMES.has(tool.name));
}
