import { t } from "@lingui/core/macro";

/**
 * Fleet: a short device label for the user agent that answered an ask card.
 * The fleet's own sessions are named by their user agent.
 */
export function answeredByDeviceLabel(userAgent: string | undefined): string {
  const ua = userAgent?.trim() ?? "";
  if (!ua) return t`unknown device`;
  if (ua.startsWith("fleet-service")) return t`fleet service`;
  if (ua.startsWith("fleet-ui-driver")) return t`test browser`;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? t`Android phone` : t`Android tablet`;
  if (/iPhone/i.test(ua)) return t`iPhone`;
  if (/iPad/i.test(ua)) return t`iPad`;
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /CrOS/i.test(ua)
        ? "ChromeOS"
        : /Linux/i.test(ua)
          ? "Linux"
          : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (os && browser) return `${os} · ${browser}`;
  return os ?? browser ?? ua.slice(0, 40);
}
