import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import {
  groupBotsForSidebar,
  nestRosterByParent,
  orderRosterWithActiveFirst,
  type RosterActivityState,
} from "@rakazo/core";
import {
  adoptDeletedSpaceFallback,
  type MobileBot,
  type MobileGroup,
  type MobileSpace,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "./api";

export type InboxSpace = Pick<
  MobileSpace,
  "id" | "name" | "isDefault" | "hasContent" | "canDelete" | "botSections"
> & {
  bots: (MobileBot | SpaceBot)[];
  groups: (MobileGroup | SpaceGroup)[];
};

export type InboxSpaceItem =
  | {
      type: "bot";
      bot: MobileBot | SpaceBot;
      depth: number;
      hasChildren: boolean;
    }
  | { type: "group"; group: MobileGroup | SpaceGroup }
  | { type: "heading"; key: string; title: string; space?: InboxSpace; sectionId?: string };

export function canDeleteInboxSpace(
  space: Pick<InboxSpace, "isDefault" | "hasContent" | "canDelete">,
) {
  return !space.isDefault && !space.hasContent && space.canDelete === true;
}

/** A brand-new space renders only its heading until it has a bot or group. */
export function inboxNeedsCreateHint(items: readonly { type: string }[]): boolean {
  return items.length > 0 && items.every((item) => item.type === "heading");
}

export function spaceInboxItems(
  spaces: InboxSpace[],
  collapsedParentIds: ReadonlySet<string> = new Set(),
  editableSpaceId?: string,
  activity: RosterActivityState = new Map(),
): InboxSpaceItem[] {
  const perSpace = spaces.map((space) => {
    const chats = [
      ...space.bots.map((chat) => ({
        type: "bot" as const,
        bot: chat,
        id: chat.id,
        parentBotId: chat.parentBotId,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
      ...space.groups.map((chat) => ({
        type: "group" as const,
        group: chat,
        id: chat.id,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
    ];
    return {
      space,
      empty: chats.length === 0,
      groups: groupBotsForSidebar(chats, space.botSections, { includeEmptySections: true }).map(
        (group) => ({ ...group, spaceId: space.id }),
      ),
    };
  });
  // Fleet patch: active bots (working, waiting for an answer, unread) lead the whole list,
  // newest activity first; rooms and everything else keep their place.
  const ordered = orderRosterWithActiveFirst(
    perSpace.flatMap((entry) => entry.groups),
    activity,
    (item) => (item.type === "bot" ? item.id : null),
  );
  const items: InboxSpaceItem[] = [];
  for (const item of ordered.active) {
    if (item.type === "bot") items.push({ type: "bot", bot: item.bot, depth: 0, hasChildren: false });
  }
  for (const { space, empty } of perSpace) {
    if (spaces.length > 1 || !space.isDefault || empty) {
      items.push({ type: "heading", key: space.id, title: space.name, space });
    }
    for (const group of ordered.groups) {
      if (group.spaceId !== space.id) continue;
      if (group.title) {
        items.push({
          type: "heading",
          key: `${space.id}:${group.key}`,
          title: group.title,
          ...(space.id === editableSpaceId && group.key.startsWith("section:")
            ? { sectionId: group.key.slice("section:".length) }
            : {}),
        });
      }
      for (const row of nestRosterByParent(group.bots, collapsedParentIds)) {
        if (row.item.type === "bot") {
          items.push({
            type: "bot",
            bot: row.item.bot,
            depth: row.depth,
            hasChildren: row.hasChildren,
          });
        } else {
          items.push({ type: "group", group: row.item.group });
        }
      }
    }
  }
  return items;
}

export async function selectInboxSpace(spaceId: string, refresh: () => Promise<void>) {
  if (!(await selectSpace(spaceId).catch(() => false))) return false;
  await refresh();
  return true;
}

export async function retryInboxSpaceFallback(spaceId: string, refresh: () => Promise<void>) {
  if (!(await adoptDeletedSpaceFallback(spaceId))) return false;
  await refresh();
  return true;
}

// Return the selection to retry if native storage fails after a successful deletion.
// The inbox must not refresh against the deleted selection in that case.
export async function removeInboxSpace(
  spaceId: string,
  refresh: () => Promise<void>,
): Promise<string | null> {
  const response = await rpc<{ ok: true; activeSpaceId: string }>("spaces/remove", { spaceId });
  if (selectedSpaceId() === spaceId) {
    if (await selectSpace(response.activeSpaceId).catch(() => false)) {
      await refresh();
      return null;
    }
    const durable = await adoptDeletedSpaceFallback(response.activeSpaceId);
    await refresh();
    return durable ? null : response.activeSpaceId;
  }
  await refresh();
  return null;
}
