import type { StreamdownProps } from "streamdown";
import { useEffect, useMemo, useState } from "react";

import { StreamdownTable } from "./streamdown-table";

type StreamdownRuntime = {
  Streamdown: typeof import("streamdown").Streamdown;
  plugins: {
    cjk: typeof import("@streamdown/cjk").cjk;
    code: typeof import("@streamdown/code").code;
    math: typeof import("@streamdown/math").math;
    mermaid: typeof import("@streamdown/mermaid").mermaid;
  };
};

let runtimePromise: Promise<StreamdownRuntime> | undefined;

const loadRuntime = (): Promise<StreamdownRuntime> => {
  runtimePromise ??= Promise.all([
    import("streamdown"),
    import("@streamdown/cjk"),
    import("@streamdown/code"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
  ]).then(([streamdown, cjk, code, math, mermaid]) => ({
    Streamdown: streamdown.Streamdown,
    plugins: {
      cjk: cjk.cjk,
      code: code.code,
      math: math.math,
      mermaid: mermaid.mermaid,
    },
  }));
  return runtimePromise;
};

export type StreamdownRendererProps = StreamdownProps;

/** Loads the Markdown renderer only when a message is actually displayed. */
export const StreamdownRenderer = ({
  children,
  plugins,
  ...props
}: StreamdownRendererProps) => {
  const [runtime, setRuntime] = useState<StreamdownRuntime>();

  useEffect(() => {
    let active = true;
    void loadRuntime().then((nextRuntime) => {
      if (active) {
        setRuntime(nextRuntime);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const components = useMemo(
    () => ({
      ...props.components,
      table: props.components?.table ?? StreamdownTable,
    }),
    [props.components],
  );

  if (!runtime) {
    return <div className={props.className}>{children}</div>;
  }

  const Component = runtime.Streamdown;
  return (
    <Component
      {...props}
      components={components}
      plugins={plugins ?? runtime.plugins}
    >
      {children}
    </Component>
  );
};
