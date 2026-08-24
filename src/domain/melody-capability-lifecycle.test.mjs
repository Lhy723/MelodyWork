import assert from "node:assert/strict";
import test from "node:test";

import { MelodyCapabilityLifecycle } from "./melody-capability-lifecycle.ts";

const capability = (overrides = {}) => ({
  kind: "skills",
  name: "review",
  path: "/skills/review",
  scope: "user",
  provider: "melody",
  managed: false,
  enabled: true,
  ...overrides,
});

test("installed plugin identity wins when discovery reports the same path", async () => {
  const installed = capability({
    kind: "plugins",
    path: "/plugins/review",
    managed: true,
  });
  const discovered = capability({
    kind: "plugins",
    path: "/plugins/review",
    managed: false,
  });
  const lifecycle = new MelodyCapabilityLifecycle({
    listDiscovered: async () => [discovered],
    listSkills: async () => [],
    listInstalledPlugins: async () => [installed],
    setEnabled: async () => {},
  });

  assert.deepEqual(await lifecycle.load("/workspace", "plugins"), [installed]);
});

test("skill state changes refresh runtime discovery after persistence", async () => {
  const events = [];
  const refreshed = capability({ enabled: false });
  const lifecycle = new MelodyCapabilityLifecycle({
    listDiscovered: async () => [],
    listSkills: async () => {
      events.push("refresh");
      return [refreshed];
    },
    listInstalledPlugins: async () => [],
    setEnabled: async () => {
      events.push("persist");
    },
  });

  assert.deepEqual(
    await lifecycle.changeEnabled("/workspace", capability(), false),
    [refreshed],
  );
  assert.deepEqual(events, ["persist", "refresh"]);
});

test("plugin state changes do not perform an unnecessary rediscovery", async () => {
  let loads = 0;
  const lifecycle = new MelodyCapabilityLifecycle({
    listDiscovered: async () => {
      loads += 1;
      return [];
    },
    listSkills: async () => [],
    listInstalledPlugins: async () => [],
    setEnabled: async () => {},
  });

  const result = await lifecycle.changeEnabled(
    "/workspace",
    capability({ kind: "plugins" }),
    false,
  );
  assert.equal(result, undefined);
  assert.equal(loads, 0);
});
