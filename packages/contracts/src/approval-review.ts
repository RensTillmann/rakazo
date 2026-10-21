import * as z from "zod";

/**
 * What the Fleet's `zd_reply_context` MCP tool returns as structuredContent: the customer-visible
 * thread as one `inquiry` text (oldest first; internal notes left out; `bounded` when shortened,
 * `note` naming the cuts), the `thread` it covers, and `source`, the conversation at its newest
 * public customer comment (null when the customer never wrote).
 */
export const CustomerReplyContextSchema = z.object({
  ticket: z.string(),
  subject: z.string(),
  source: z.object({ ref: z.string(), version: z.string() }).nullable(),
  firstInquiry: z.string().nullable(),
  thread: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["customer", "agent"]),
      author: z.string(),
      createdAt: z.string(),
      inInquiry: z.enum(["full", "cut"]),
    }),
  ),
  inquiry: z.string(),
  bounded: z.boolean(),
  note: z.string().optional(),
});
export type CustomerReplyContext = z.infer<typeof CustomerReplyContextSchema>;

export const ApprovalReviewSchema = z.object({
  ticket: z.string(),
  proposedReply: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  /** The conversation version of the reply card Rens approved this reply on; null when none. */
  cardVersion: z.string().nullable(),
  customerContext: z.discriminatedUnion("status", [
    CustomerReplyContextSchema.extend({
      status: z.literal("available"),
      /** The customer wrote again after the card's version; null when either version is unknown. */
      stale: z.boolean().nullable(),
    }),
    z.object({ status: z.literal("unavailable") }),
  ]),
});
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;
