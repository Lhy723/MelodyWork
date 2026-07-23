export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  id: string;
  projectId: string;
  toolKey: string;
  title: string;
  command: string;
  decision: PermissionDecision;
  createdAt: number;
}
