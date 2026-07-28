import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation";
import {
  resolveProjectReference,
  type ProjectReference,
} from "@/domain/message-citations";
import { FileIcon, FolderIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

interface ProjectInlineCitationProps extends ComponentProps<"code"> {
  children?: ReactNode;
  cwd: string;
  projectRoot: string;
}

const childText = (children: ReactNode) =>
  typeof children === "string" || typeof children === "number"
    ? String(children)
    : undefined;

const referenceLabel = (reference: ProjectReference) => {
  const ReferenceIcon =
    reference.kind === "folder" ? FolderIcon : FileIcon;
  return (
    <>
      <ReferenceIcon aria-hidden className="size-3" />
      <span className="sr-only">
        {reference.kind === "folder" ? "文件夹" : "文件"}
      </span>
    </>
  );
};

export function ProjectInlineCitation({
  children,
  className,
  cwd,
  node: _node,
  projectRoot,
  ...props
}: ProjectInlineCitationProps & { node?: unknown }) {
  const text = childText(children);
  const reference = text
    ? resolveProjectReference(text, projectRoot, cwd)
    : undefined;

  if (!reference) {
    return (
      <code
        className={`rounded bg-muted px-1.5 py-0.5 font-mono text-sm ${className ?? ""}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <InlineCitation>
      <InlineCitationText>
        <code
          className={`rounded bg-muted px-1.5 py-0.5 font-mono text-sm ${className ?? ""}`}
          {...props}
        >
          {children}
        </code>
      </InlineCitationText>
      <InlineCitationCard>
        <InlineCitationCardTrigger
          aria-label={`查看项目${reference.kind === "folder" ? "文件夹" : "文件"} ${reference.displayPath}`}
          className="ml-0.5 gap-1 px-1.5"
          label={referenceLabel(reference)}
          sources={[]}
        />
        <InlineCitationCardBody className="w-96 p-4">
          <InlineCitationSource
            description={
              reference.kind === "folder"
                ? "当前项目中的文件夹"
                : "当前项目中的文件"
            }
            title={reference.displayPath}
            url={reference.absolutePath}
          />
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}
