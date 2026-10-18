import { describe, expect, it } from "vitest";
import { isVideoAttachment } from "./video-attachment";

describe("isVideoAttachment", () => {
  it("plays any video type", () => {
    expect(isVideoAttachment("video/webm", "recording.webm")).toBe(true);
    expect(isVideoAttachment("video/mp4", "clip")).toBe(true);
    expect(isVideoAttachment("Video/WebM; codecs=vp9", "recording")).toBe(true);
  });

  it("sniffs a video file name when the stored type is generic", () => {
    for (const name of ["recording.webm", "clip.MP4", "clip.m4v", "screen.mov", "a.ogv"]) {
      expect(isVideoAttachment("application/octet-stream", name), name).toBe(true);
      expect(isVideoAttachment("", name), name).toBe(true);
    }
  });

  it("keeps other files as files", () => {
    expect(isVideoAttachment("application/octet-stream", "dump.bin")).toBe(false);
    expect(isVideoAttachment("application/pdf", "report.pdf")).toBe(false);
    // A specific non-video type wins over a misleading name.
    expect(isVideoAttachment("text/plain", "notes.webm")).toBe(false);
    expect(isVideoAttachment("audio/webm", "speech.webm")).toBe(false);
  });
});
