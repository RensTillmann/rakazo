/**
 * Orange attention dot at the top right of a roster avatar in the collapsed (avatar-only) sidebar.
 * `label` is "Needs your answer" or "Unread"; null renders nothing. The ring uses the sidebar
 * background so the dot reads on any avatar colour.
 */
export function RosterAttentionBadge({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-roster-attention-dot=""
      data-roster-attention-badge=""
      className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-warning"
    />
  );
}
