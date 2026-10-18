const VIDEO_EXTENSIONS = /\.(webm|mp4|m4v|mov|ogv)$/i;
const GENERIC_MIME_TYPES: Record<string, true> = {
  "": true,
  "application/octet-stream": true,
  "binary/octet-stream": true,
};

/**
 * A file attachment the chat plays inline: any `video/*` type, or a video file name when
 * the stored type says nothing (an upload or an older artifact saved as octet-stream).
 */
export function isVideoAttachment(mimeType: string, name: string): boolean {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("video/")) return true;
  return GENERIC_MIME_TYPES[type] === true && VIDEO_EXTENSIONS.test(name.trim());
}
