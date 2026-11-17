// -----------------------------------------------------------------------------
// "Uscita audio": which outputs this computer has (speakers, headphones,
// Bluetooth), which one is in use, and the quickest way to change it.
//
// The music plays inside YouTube's / Spotify's own frames: a web page can't
// route that audio to another output (setSinkId only works on the page's own
// media), and capturing the tab to re-route it would break YouTube's and
// Spotify's terms. So the computer picks the output; the app shows the list,
// marks the one in use, follows changes live, and opens the system's picker.
// -----------------------------------------------------------------------------

export type Os = "windows" | "mac" | "other";
export type OutKind = "headphones" | "bluetooth" | "speaker";

export interface Output {
  id: string;
  /** "" until the browser gives names (a one-time permission in Chrome / Edge). */
  label: string;
  kind: OutKind;
  active: boolean;
}

/** Windows, macOS or something else (phones, Linux). */
export function osOf(nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } } = typeof navigator !== "undefined" ? navigator : {}): Os {
  const p = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/iphone|ipad|android/i.test(p)) return "other";
  if (/win/i.test(p)) return "windows";
  if (/mac/i.test(p)) return "mac";
  return "other";
}

/** The system page where the output is chosen (opened from the app; the browser asks first). */
export function systemPickerUrl(os: Os): string | null {
  if (os === "windows") return "ms-settings:apps-volume"; // App volume and device preferences (also per app)
  if (os === "mac") return "x-apple.systempreferences:com.apple.preference.sound?output";
  return null;
}

/** Headphones, Bluetooth or a speaker, from the device's name. */
export function kindOf(label: string): OutKind {
  if (/airpods|buds|bluetooth|\bbt\b|hands-?free|jbl|bose|sony wh|wf-/i.test(label)) return "bluetooth";
  if (/head ?phone|headset|cuffi|auricolar|earphone|ear ?pods/i.test(label)) return "headphones";
  return "speaker";
}

/** Chrome / Edge name the default "Default - <device>" (localized): the device's own name. */
export function stripDefault(label: string): string {
  return label.replace(/^(default|predefinit[oa]|standard|par défaut|predeterminado)\s*[-–:]\s*/i, "").trim();
}

/** The outputs, without the "default" / "communications" aliases, the one in use marked. */
export function outputsOf(devices: Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[]): { outputs: Output[]; inUse: string | null } {
  const outs = devices.filter((d) => d.kind === "audiooutput");
  const def = outs.find((d) => d.deviceId === "default");
  const inUse = def?.label ? stripDefault(def.label) : null;
  const outputs = outs
    .filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ id: d.deviceId, label: d.label, kind: kindOf(d.label), active: !!inUse && d.label === inUse }));
  // A browser that lists only the alias still says how many there are.
  if (!outputs.length && def) outputs.push({ id: "default", label: inUse ?? "", kind: kindOf(inUse ?? ""), active: true });
  return { outputs, inUse };
}
