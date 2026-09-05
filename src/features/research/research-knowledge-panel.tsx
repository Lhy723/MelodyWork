import { BookOpenIcon } from "lucide-react";
import { useMemo } from "react";

import { useResearchStore } from "./research-store";

export function KnowledgePanel() {
  const papers = useResearchStore((state) => state.papers);
  const saved = papers.filter((paper) => paper.saved);
  const venues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of saved) {
      if (paper.venue) {
        counts.set(paper.venue, (counts.get(paper.venue) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort(
      (left, right) => right[1] - left[1],
    );
  }, [saved]);

  return (
    <div className="size-full overflow-y-auto p-4">
      <div className="flex items-center gap-2 border-b pb-3">
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">知识资产</h2>
      </div>
      {saved.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-xs">
          收藏论文后，这里会从真实元信息中聚合来源和研究主题。
        </p>
      ) : (
        <>
          <p className="mt-4 text-muted-foreground text-xs">
            {saved.length} 篇收藏论文 · {venues.length} 个出版来源
          </p>
          <div className="mt-3 divide-y rounded-lg border">
            {venues.map(([venue, count]) => (
              <div className="flex items-center px-3 py-2 text-xs" key={venue}>
                <span className="min-w-0 flex-1 truncate">{venue}</span>
                <span className="text-muted-foreground">{count} 篇</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
