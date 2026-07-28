import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation";
import { extractMessageCitations } from "@/domain/message-citations";
import { openExternalUrl } from "@/lib/melody-bridge";
import { useMemo } from "react";

interface MessageCitationsProps {
  content: string;
}

export function MessageCitations({
  content,
}: MessageCitationsProps) {
  const citations = useMemo(
    () => extractMessageCitations(content),
    [content],
  );

  if (citations.length === 0) {
    return null;
  }

  const sources = citations.map((citation) => citation.url);

  return (
    <InlineCitation className="mt-1.5 inline-flex">
      <InlineCitationText className="text-muted-foreground text-xs">
        引用
      </InlineCitationText>
      <InlineCitationCard>
        <InlineCitationCardTrigger
          aria-label={`查看 ${citations.length} 个引用来源`}
          className="cursor-default"
          sources={sources}
        />
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselNext />
              <InlineCitationCarouselIndex />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              {citations.map((citation) => (
                <InlineCitationCarouselItem key={citation.url}>
                  <button
                    className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void openExternalUrl(citation.url)}
                    title="在浏览器中打开"
                    type="button"
                  >
                    <InlineCitationSource
                      description="点击在浏览器中打开此来源"
                      title={citation.title}
                      url={citation.url}
                    />
                  </button>
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}
