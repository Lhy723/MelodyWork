import { lazy } from "react";

export const MonacoEditor = lazy(async () => {
  const [reactMonaco, monaco] = await Promise.all([
    import("@monaco-editor/react"),
    import("monaco-editor"),
  ]);
  reactMonaco.loader.config({ monaco });
  return { default: reactMonaco.default };
});
