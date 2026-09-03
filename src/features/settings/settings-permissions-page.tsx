import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { LoadingButton } from "@/components/interior/loading-button";
import { Modal } from "@/components/interior/modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { PermissionRule } from "@/domain/permission";

interface SettingsPermissionsPageProps {
  loading: boolean;
  onRefresh: () => Promise<void>;
  onRemoveRule: (id: string) => void | Promise<void>;
  rules: PermissionRule[];
}

export function SettingsPermissionsPage({
  loading,
  onRefresh,
  onRemoveRule,
  rules,
}: SettingsPermissionsPageProps) {
  const [pendingDeleteRule, setPendingDeleteRule] = useState<PermissionRule>();
  const [deletingRuleId, setDeletingRuleId] = useState<string>();

  const removeRule = async () => {
    if (!pendingDeleteRule || deletingRuleId) return;
    const rule = pendingDeleteRule;
    setDeletingRuleId(rule.id);
    try {
      await onRemoveRule(rule.id);
      setPendingDeleteRule(undefined);
    } finally {
      setDeletingRuleId(undefined);
    }
  };

  return (
    <>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-2xl">项目权限规则</h3>
              <p className="mt-1 text-muted-foreground text-sm">
                已为此项目允许或拒绝的精确工具调用会自动应用。
              </p>
            </div>
            <LoadingButton
              disabled={loading}
              errorLabel="重试"
              icon={<RefreshCwIcon />}
              onAction={onRefresh}
              pendingLabel="刷新中…"
              successLabel="已刷新"
              variant="outline"
            >
              刷新
            </LoadingButton>
          </div>

          <div className="mt-6 flex flex-col gap-3">
            {rules.map((rule, index) => (
              <article
                className="motion-list-item flex items-start gap-4 rounded-2xl border bg-card p-4"
                key={rule.id}
                style={{
                  animationDelay: `${Math.min(index, 6) * 24}ms`,
                }}
              >
                <Badge
                  variant={
                    rule.decision === "allow" ? "secondary" : "destructive"
                  }
                >
                  {rule.decision === "allow" ? "允许" : "拒绝"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <h4 className="font-medium text-sm">{rule.title}</h4>
                  {rule.command ? (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-mono text-xs">
                      {rule.command}
                    </pre>
                  ) : null}
                </div>
                <Button
                  aria-label={`删除“${rule.title}”权限规则`}
                  onClick={() => setPendingDeleteRule(rule)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </article>
            ))}
            {!loading && rules.length === 0 ? (
              <div className="motion-view-enter rounded-2xl border border-dashed py-16 text-center">
                <ShieldCheckIcon className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-3 font-medium text-sm">暂无项目规则</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  在权限请求中选择“对项目允许”或“对项目拒绝”即可创建规则。
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <Modal
        description={`将删除“${pendingDeleteRule?.title ?? ""}”的自动权限规则，之后再次触发时需要重新确认。`}
        footer={
          <>
            <Button
              disabled={Boolean(deletingRuleId)}
              onClick={() => {
                if (!deletingRuleId) setPendingDeleteRule(undefined);
              }}
              variant="outline"
            >
              取消
            </Button>
            <HoldToConfirm
              confirmLabel={deletingRuleId ? "删除中…" : "已删除"}
              disabled={Boolean(deletingRuleId)}
              onConfirm={removeRule}
              variant="destructive"
            >
              删除规则
            </HoldToConfirm>
          </>
        }
        onClose={() => {
          if (!deletingRuleId) setPendingDeleteRule(undefined);
        }}
        open={Boolean(pendingDeleteRule)}
        title="删除项目权限规则？"
      />
    </>
  );
}
