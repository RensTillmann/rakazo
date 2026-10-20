import * as z from "zod";

export const CustomerReplyContextSchema = z.object({
  ticket: z.string(),
  subject: z.string(),
  latestCommentId: z.string().nullable(),
  customerMessage: z
    .object({
      id: z.string(),
      author: z.string(),
      createdAt: z.string(),
      body: z.string(),
    })
    .nullable(),
});

export const ApprovalReviewSchema = z.object({
  ticket: z.string(),
  proposedReply: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  expectedLastCommentId: z.string().nullable(),
  customerContext: z.discriminatedUnion("status", [
    CustomerReplyContextSchema.extend({
      status: z.literal("available"),
      stale: z.boolean().nullable(),
    }),
    z.object({ status: z.literal("unavailable") }),
  ]),
});
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;
