import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const DEFAULT_BASE_URL = "http://hindsight:8888";
const DEFAULT_BANKS = "fleet,knowledge,public";
const DEFAULT_EXCLUDE_TAGS = "pii:person,embargo:security";

/** Hindsight is recall-only here: saving goes through memory_save on the fleet MCP. */
export function HindsightSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const baseUrlId = useId();
  const banksId = useId();
  const excludeTagsId = useId();
  const apiKeyId = useId();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [banks, setBanks] = useState(DEFAULT_BANKS);
  const [excludeTags, setExcludeTags] = useState(DEFAULT_EXCLUDE_TAGS);
  const [apiKey, setApiKey] = useState("");

  async function connect() {
    if (!apiKey.trim()) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        baseUrl: baseUrl.trim(),
        banks: banks.trim(),
        excludeTags: excludeTags.trim(),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field>
        <FieldLabel htmlFor={baseUrlId}>
          <Trans>Base URL</Trans>
        </FieldLabel>
        <Input
          id={baseUrlId}
          value={baseUrl}
          disabled={busy}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={DEFAULT_BASE_URL}
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={banksId}>
          <Trans>Banks (comma-separated)</Trans>
        </FieldLabel>
        <Input
          id={banksId}
          value={banks}
          disabled={busy}
          onChange={(event) => setBanks(event.target.value)}
          placeholder={DEFAULT_BANKS}
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={excludeTagsId}>
          <Trans>Never recall tags (comma-separated)</Trans>
        </FieldLabel>
        <Input
          id={excludeTagsId}
          value={excludeTags}
          disabled={busy}
          onChange={(event) => setExcludeTags(event.target.value)}
          placeholder={DEFAULT_EXCLUDE_TAGS}
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>Instance API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || apiKey.trim().length < 8 || !baseUrl.trim()}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
