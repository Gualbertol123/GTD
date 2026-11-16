import { describe, expect, it } from "vitest";
import { PHONE_EN, PHONE_IT } from "../i18n.music.phone";
import { MUSIC_EN, MUSIC_IT } from "../i18n.music";

// The "tap YouTube's frame" caption (needsTap) and the Premium cookie note:
// present in both languages, merged into the music dictionaries, and pointing
// at the video, not at the app's own Play button.
describe("phone music strings", () => {
  it("has the tap caption and the Premium cookie note in IT and EN", () => {
    for (const k of ["music.tapVideo", "music.premiumCookies"]) {
      expect(PHONE_IT[k]).toBeTruthy();
      expect(PHONE_EN[k]).toBeTruthy();
      expect(MUSIC_IT[k]).toBe(PHONE_IT[k]);
      expect(MUSIC_EN[k]).toBe(PHONE_EN[k]);
    }
    expect(PHONE_IT["music.tapVideo"]).toMatch(/video/i);
    expect(PHONE_EN["music.tapVideo"]).toMatch(/video/i);
    expect(PHONE_IT["music.premiumCookies"]).toMatch(/cookie/i);
    expect(PHONE_EN["music.premiumCookies"]).toMatch(/Safari/);
  });
});
