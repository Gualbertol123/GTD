import { describe, expect, it } from "vitest";
import { kindOf, osOf, outputsOf, stripDefault, systemPickerUrl } from "../audioOutput";

const dev = (deviceId: string, label: string, kind = "audiooutput") => ({ deviceId, label, kind }) as MediaDeviceInfo;

describe("audio output panel helpers", () => {
  it("tells Windows, macOS and phones apart", () => {
    expect(osOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" })).toBe("windows");
    expect(osOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", platform: "MacIntel" })).toBe("mac");
    expect(osOf({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(osOf({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone" })).toBe("other");
    expect(osOf({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l" })).toBe("other");
  });

  it("opens the right system page", () => {
    expect(systemPickerUrl("windows")).toBe("ms-settings:apps-volume");
    expect(systemPickerUrl("mac")).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.sound/);
    expect(systemPickerUrl("other")).toBeNull();
  });

  it("guesses headphones, Bluetooth and speakers from the name", () => {
    expect(kindOf("AirPods Pro")).toBe("bluetooth");
    expect(kindOf("Cuffie (Realtek)")).toBe("headphones");
    expect(kindOf("Headphones (USB Audio)")).toBe("headphones");
    expect(kindOf("Altoparlanti (Realtek High Definition Audio)")).toBe("speaker");
    expect(kindOf("MacBook Pro Speakers")).toBe("speaker");
  });

  it("marks the output in use from Chrome's 'Default - …' alias, without listing the aliases", () => {
    const r = outputsOf([
      dev("default", "Predefinito - AirPods Pro"),
      dev("communications", "Comunicazioni - Altoparlanti (Realtek)"),
      dev("a1", "Altoparlanti (Realtek)"),
      dev("b2", "AirPods Pro"),
      dev("m1", "Microfono", "audioinput"),
    ]);
    expect(r.inUse).toBe("AirPods Pro");
    expect(r.outputs.map((o) => [o.label, o.active])).toEqual([
      ["Altoparlanti (Realtek)", false],
      ["AirPods Pro", true],
    ]);
    expect(stripDefault("Default - MacBook Pro Speakers")).toBe("MacBook Pro Speakers");
  });

  it("without names it still counts the outputs", () => {
    const r = outputsOf([dev("default", ""), dev("x", ""), dev("y", "")]);
    expect(r.inUse).toBeNull();
    expect(r.outputs).toHaveLength(2);
  });
});
