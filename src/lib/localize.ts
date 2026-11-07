import { isUntitledSessionTitle } from "@/domain/workspace";

export const localizedSessionTitle = (title: string) =>
  isUntitledSessionTitle(title) ? "新会话" : title;
