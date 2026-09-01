"use client";

import { InputGroup } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import { nanoid } from "nanoid";
import type {
  ChangeEventHandler,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  LocalAttachmentsContext,
  LocalReferencedSourcesContext,
  type AttachmentsContext,
  type ReferencedSourcesContext,
  useOptionalPromptInputController,
} from "./prompt-input-context";
import { convertBlobUrlToDataUrl } from "./prompt-input-utils";

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> & {
  accept?: string;
  multiple?: boolean;
  globalDrop?: boolean;
  syncHiddenInput?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (error: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const controller = useOptionalPromptInputController();
  const usingProvider = Boolean(controller);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [localFiles, setLocalFiles] = useState<(FileUIPart & { id: string })[]>(
    [],
  );
  const files = controller?.attachments.files ?? localFiles;
  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openLocalFileDialog = useCallback(() => inputRef.current?.click(), []);
  const matchesAccept = useCallback(
    (file: File) => {
      if (!accept?.trim()) return true;
      return accept.split(",").some((rawPattern) => {
        const pattern = rawPattern.trim();
        if (!pattern) return false;
        if (pattern.startsWith(".")) {
          return file.name.toLowerCase().endsWith(pattern.toLowerCase());
        }
        if (pattern.endsWith("/*")) {
          return file.type.startsWith(pattern.slice(0, -1));
        }
        return file.type === pattern;
      });
    },
    [accept],
  );
  const validateFiles = useCallback(
    (incomingFiles: File[] | FileList, currentCount: number) => {
      const incoming = [...incomingFiles];
      const accepted = incoming.filter(matchesAccept);
      if (incoming.length && accepted.length === 0) {
        onError?.({ code: "accept", message: "没有符合支持类型的文件。" });
        return [];
      }
      const sized = maxFileSize
        ? accepted.filter((file) => file.size <= maxFileSize)
        : accepted;
      if (accepted.length && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "所有文件都超过了大小限制。",
        });
        return [];
      }
      const capacity =
        typeof maxFiles === "number"
          ? Math.max(0, maxFiles - currentCount)
          : undefined;
      const capped =
        typeof capacity === "number" ? sized.slice(0, capacity) : sized;
      if (typeof capacity === "number" && sized.length > capacity) {
        onError?.({
          code: "max_files",
          message: "文件数量过多，部分文件未添加。",
        });
      }
      return capped;
    },
    [matchesAccept, maxFileSize, maxFiles, onError],
  );
  const addLocal = useCallback(
    (incoming: File[] | FileList) => {
      const accepted = validateFiles(incoming, localFiles.length);
      if (!accepted.length) return;
      setLocalFiles((current) => [
        ...current,
        ...accepted.map((file) => ({
          filename: file.name,
          id: nanoid(),
          mediaType: file.type,
          type: "file" as const,
          url: URL.createObjectURL(file),
        })),
      ]);
    },
    [localFiles.length, validateFiles],
  );
  const addProvider = useCallback(
    (incoming: File[] | FileList) => {
      const accepted = validateFiles(incoming, files.length);
      if (accepted.length) controller?.attachments.add(accepted);
    },
    [controller, files.length, validateFiles],
  );
  const add = usingProvider ? addProvider : addLocal;
  const removeLocal = useCallback((id: string) => {
    setLocalFiles((current) => {
      const found = current.find((file) => file.id === id);
      if (found?.url) URL.revokeObjectURL(found.url);
      return current.filter((file) => file.id !== id);
    });
  }, []);
  const remove = controller?.attachments.remove ?? removeLocal;
  const clearAttachments = useCallback(() => {
    if (usingProvider) {
      controller?.attachments.clear();
      return;
    }
    setLocalFiles((current) => {
      for (const file of current) {
        if (file.url) URL.revokeObjectURL(file.url);
      }
      return [];
    });
  }, [controller, usingProvider]);
  const clearReferencedSources = useCallback(
    () => setReferencedSources([]),
    [],
  );
  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);
  const openFileDialog =
    controller?.attachments.openFileDialog ?? openLocalFileDialog;

  useEffect(() => {
    if (usingProvider) {
      controller?.__registerFileInput(inputRef, openLocalFileDialog);
    }
  }, [controller, openLocalFileDialog, usingProvider]);
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files.length, syncHiddenInput]);
  useEffect(() => {
    const form = formRef.current;
    if (!form || globalDrop) return;
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      if (event.dataTransfer?.files.length) add(event.dataTransfer.files);
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);
  useEffect(() => {
    if (!globalDrop) return;
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      if (event.dataTransfer?.files.length) add(event.dataTransfer.files);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);
  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const file of filesRef.current) {
          if (file.url) URL.revokeObjectURL(file.url);
        }
      }
    },
    [usingProvider],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) add(event.currentTarget.files);
      event.currentTarget.value = "";
    },
    [add],
  );
  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      fileInputRef: inputRef,
      files: files.map((file) => ({ ...file, id: file.id })),
      openFileDialog,
      remove,
    }),
    [add, clearAttachments, files, openFileDialog, remove],
  );
  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      add: (incoming) => {
        const values = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((current) => [
          ...current,
          ...values.map((source) => ({ ...source, id: nanoid() })),
        ]);
      },
      clear: clearReferencedSources,
      remove: (id) =>
        setReferencedSources((current) =>
          current.filter((source) => source.id !== id),
        ),
      sources: referencedSources,
    }),
    [clearReferencedSources, referencedSources],
  );
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const text = usingProvider
        ? (controller?.textInput.value ?? "")
        : String(new FormData(form).get("message") ?? "");
      if (!usingProvider) form.reset();
      try {
        const convertedFiles = await Promise.all(
          files.map(async (file) => {
            const item = { ...file };
            Reflect.deleteProperty(item, "id");
            if (item.url?.startsWith("blob:")) {
              const dataUrl = await convertBlobUrlToDataUrl(item.url);
              return { ...item, url: dataUrl ?? item.url };
            }
            return item;
          }),
        );
        const result = onSubmit({ files: convertedFiles, text }, event);
        await result;
        clear();
        if (usingProvider) controller?.textInput.clear();
      } catch {
        // Preserve the draft and attachments when submission fails.
      }
    },
    [clear, controller, files, onSubmit, usingProvider],
  );

  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <LocalReferencedSourcesContext.Provider value={refsCtx}>
        <input
          accept={accept}
          aria-label="上传文件"
          className="hidden"
          multiple={multiple}
          onChange={handleChange}
          ref={inputRef}
          title="上传文件"
          type="file"
        />
        <form
          className={cn("w-full", className)}
          onSubmit={handleSubmit}
          ref={formRef}
          {...props}
        >
          <InputGroup className="overflow-hidden">{children}</InputGroup>
        </form>
      </LocalReferencedSourcesContext.Provider>
    </LocalAttachmentsContext.Provider>
  );
};
