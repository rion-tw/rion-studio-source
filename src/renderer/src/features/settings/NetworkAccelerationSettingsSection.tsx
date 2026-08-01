import { type FormEvent, type JSX, useEffect, useState } from "react";

import type { BrowserProxySettings } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SegmentedControl, SettingsRow, SettingsSection } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Translator } from "../../i18n";

interface NetworkAccelerationSettingsSectionProps {
  hasRunningRoles: boolean;
  settings: BrowserProxySettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (settings: BrowserProxySettings) => Promise<BrowserProxySettings>;
}

const defaultEndpoint = {
  protocol: "http" as const,
  host: "127.0.0.1",
  port: 7890
};

export function NetworkAccelerationSettingsSection({
  hasRunningRoles,
  settings,
  t,
  onError,
  onSave
}: NetworkAccelerationSettingsSectionProps): JSX.Element {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const endpoint = draft.custom ?? defaultEndpoint;
  const validPort = Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (saving || (draft.mode === "custom" && !validPort)) return;
    setSaving(true);
    setSaved(false);
    const next = draft.mode === "system"
      ? { ...draft, mode: "system" as const }
      : { mode: "custom" as const, custom: endpoint };
    void onSave(next)
      .then((value) => {
        setDraft(value);
        setSaved(true);
      })
      .catch(onError)
      .finally(() => setSaving(false));
  }

  return (
    <form onSubmit={submit}>
      <SettingsSection>
        <SettingsRow
          title={t("settings.networkMode")}
          description={t("settings.networkModeDescription")}
          control={
            <SegmentedControl<BrowserProxySettings["mode"]>
              className="settings-menu-control settings-segmented-menu grid-cols-2"
              disabled={saving}
              items={[
                { value: "system", label: t("settings.networkModeSystem") },
                { value: "custom", label: t("settings.networkModeCustom") }
              ]}
              value={draft.mode}
              onValueChange={(mode) => {
                setSaved(false);
                setDraft((current) => ({ ...current, mode, custom: current.custom ?? defaultEndpoint }));
              }}
            />
          }
        />
        {draft.mode === "custom" ? (
          <>
            <SettingsRow
              title={t("settings.networkProtocol")}
              description={t("settings.networkProtocolDescription")}
              control={
                <Select
                  disabled={saving}
                  value={endpoint.protocol}
                  onValueChange={(protocol) => setDraft({
                    mode: "custom",
                    custom: { ...endpoint, protocol: protocol as "http" | "socks5" }
                  })}
                >
                  <SelectTrigger className="settings-menu-control"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              title={t("settings.networkHost")}
              description={t("settings.networkHostDescription")}
              control={
                <Select
                  disabled={saving}
                  value={endpoint.host}
                  onValueChange={(host) => setDraft({ mode: "custom", custom: { ...endpoint, host } })}
                >
                  <SelectTrigger className="settings-menu-control"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                    <SelectItem value="::1">::1</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              title={t("settings.networkPort")}
              description={validPort ? t("settings.networkPortDescription") : t("settings.networkPortInvalid")}
              control={
                <Input
                  aria-label={t("settings.networkPort")}
                  className="settings-menu-control"
                  disabled={saving}
                  inputMode="numeric"
                  max={65535}
                  min={1}
                  required
                  type="number"
                  value={endpoint.port}
                  onChange={(event) => setDraft({
                    mode: "custom",
                    custom: { ...endpoint, port: Number(event.target.value) }
                  })}
                />
              }
            />
          </>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-control text-muted-foreground">
            {hasRunningRoles
              ? t("settings.networkRestartRequired")
              : saved
                ? t("settings.networkSaved")
                : t("settings.networkSaveDescription")}
          </p>
          <Button type="submit" disabled={saving || (draft.mode === "custom" && !validPort)}>
            {saving ? t("settings.networkSaving") : t("settings.networkSave")}
          </Button>
        </div>
      </SettingsSection>
    </form>
  );
}
