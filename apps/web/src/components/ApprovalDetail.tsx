import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { APPROVAL_NEVER_AUTOMATIC_LINE } from "@rakazo/core";

/** The labels the server writes on approval-card detail lines ("To: …", "Why: …"). */
function approvalDetailLabel(label: string): string {
  if (label === "To") return t`To`;
  if (label === "Subject") return t`Subject`;
  if (label === "Title") return t`Title`;
  if (label === "Message") return t`Message`;
  if (label === "Command") return t`Command`;
  if (label === "Search for") return t`Search for`;
  if (label === "File") return t`File`;
  if (label === "Link") return t`Link`;
  if (label === "Prompt") return t`Prompt`;
  if (label === "Text") return t`Text`;
  if (label === "Access") return t`Access`;
  if (label === "Amount") return t`Amount`;
  if (label === "Where") return t`Where`;
  if (label === "Why") return t`Why`;
  if (label === "Safety check") return t`Safety check`;
  return label;
}

/** Approval detail: one plain line per argument, label in bold, a command in code style. */
export function ApprovalDetail({ detail }: { detail: string }) {
  const { t } = useLingui();
  return (
    <div
      data-testid="approval-detail"
      className="mt-3 max-h-72 space-y-1 overflow-auto rounded-xl bg-muted px-3.5 py-3 text-[13.5px] leading-[1.6] text-muted-foreground"
    >
      {detail.split("\n").map((line, index) => {
        if (line === APPROVAL_NEVER_AUTOMATIC_LINE)
          return (
            <div key={index} className="font-medium text-foreground">
              {t`Always asks you (never automatic)`}
            </div>
          );
        const field = /^([^:]{1,40}): (.+)$/.exec(line);
        if (field) {
          const value = field[2]!;
          const code = /^`(.+)`$/.exec(value);
          return (
            <div key={index} className="break-words">
              <span className="font-medium text-foreground">{approvalDetailLabel(field[1]!)}:</span>{" "}
              {code ? (
                <code className="rounded bg-background px-1 py-0.5 font-mono text-[12.5px]">
                  {code[1]}
                </code>
              ) : (
                value
              )}
            </div>
          );
        }
        // A batch card heads each action's lines with "<Action>:".
        const heading = /^(.+):$/.exec(line);
        return (
          <div key={index} className={heading ? "pt-1 font-medium text-foreground" : "break-words"}>
            {heading ? heading[1] : line}
          </div>
        );
      })}
    </div>
  );
}
