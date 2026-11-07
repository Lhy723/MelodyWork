export type ActivityAnnouncementPhase = "running" | "success" | "error";

const SENTENCE_END = /[。.]$/u;
const LATIN_TAIL = /[A-Za-z0-9]$/u;

const ENDINGS: Record<
  ActivityAnnouncementPhase,
  { suffix: string; stated: readonly string[] }
> = {
  running: { suffix: "已开始。", stated: ["已开始", "开始"] },
  success: { suffix: "已完成。", stated: ["完成", "成功"] },
  error: { suffix: "失败。", stated: ["失败", "错误"] },
};

/**
 * Compose the screen-reader sentence for an activity.
 * Callers often bake the state into the title ("移除工作树完成"), so a title
 * that already states its state is announced once instead of twice.
 */
export const activityAnnouncement = (
  title: string,
  phase: ActivityAnnouncementPhase,
): string => {
  const text = title.trim().replace(SENTENCE_END, "").trim();
  if (text.length === 0) return "";
  const { suffix, stated } = ENDINGS[phase];
  if (stated.some((ending) => text.endsWith(ending))) return `${text}。`;
  return `${text}${LATIN_TAIL.test(text) ? " " : ""}${suffix}`;
};
