import { $, browser, expect } from "@wdio/globals";

/** The menu selection is the user action; all assertions read the rendered UI. */
export async function selectGroupedDramaWebsite(): Promise<void> {
  await $("[data-workspace-web-preset-select]").click();
  const groups = await browser.$$("[data-workspace-web-category]");
  expect(await groups.map(group => group.getAttribute("data-workspace-web-category")))
    .toEqual(["media", "live", "social", "other"]);
  for (const [id, label, count] of [
    ["media", "Media", 15], ["live", "Live", 2],
    ["social", "Social", 8], ["other", "Other", 1]
  ] as const) {
    const group = await $(`[data-workspace-web-category='${id}']`);
    // textContent includes menu content below the current scroll viewport.
    expect(await group.getProperty("textContent")).toContain(label);
    expect(await group.$$("[role='option']")).toHaveLength(count);
  }
  const drama = await $("[data-workspace-web-preset='iqiyi'][role='option']");
  await drama.scrollIntoView({ block: "center" });
  await drama.click();
  await expect($("#workspace-web-name")).toHaveValue("iQIYI (International)");
  await expect($("#workspace-web-url")).toHaveValue("https://www.iq.com/");
}
