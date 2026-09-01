import { WandSparklesIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

export function CapabilityCard({
  category,
  checked,
  description,
  onCheckedChange,
  title,
  trigger,
}: {
  category?: string;
  checked: boolean;
  description: string;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  trigger?: string;
}) {
  return (
    <article className="flex items-start gap-3 border bg-background/70 p-4 transition-colors hover:bg-muted/20">
      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/30">
        <WandSparklesIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="research-serif font-semibold text-sm">{title}</h3>
          {category ? <Badge variant="outline">{category}</Badge> : null}
        </div>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {description}
        </p>
        {trigger ? (
          <p className="mt-2 text-muted-foreground text-[11px]">
            适用：{trigger}
          </p>
        ) : null}
      </div>
      <Switch
        aria-label={`${checked ? "停用" : "启用"}${title}`}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </article>
  );
}
