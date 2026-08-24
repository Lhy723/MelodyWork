import type { MelodyExtension } from "./config.ts";

export type MelodyCapabilityPage = "skills" | "plugins" | "hooks";

export interface MelodyCapabilityGateway {
  listDiscovered(cwd: string): Promise<MelodyExtension[]>;
  listSkills(cwd: string): Promise<MelodyExtension[]>;
  listInstalledPlugins(cwd: string): Promise<MelodyExtension[]>;
  setEnabled(
    cwd: string,
    capability: MelodyExtension,
    enabled: boolean,
  ): Promise<void>;
}

export class MelodyCapabilityLifecycle {
  private readonly gateway: MelodyCapabilityGateway;

  constructor(gateway: MelodyCapabilityGateway) {
    this.gateway = gateway;
  }

  async load(
    cwd: string,
    page: MelodyCapabilityPage,
  ): Promise<MelodyExtension[]> {
    const [discovered, installed] = await Promise.all([
      page === "skills"
        ? this.gateway.listSkills(cwd)
        : this.gateway.listDiscovered(cwd),
      page === "plugins" ? this.gateway.listInstalledPlugins(cwd) : [],
    ]);

    return mergeCapabilities(installed, discovered);
  }

  async changeEnabled(
    cwd: string,
    capability: MelodyExtension,
    enabled: boolean,
  ): Promise<MelodyExtension[] | undefined> {
    await this.gateway.setEnabled(cwd, capability, enabled);
    return capability.kind === "skills" ? this.load(cwd, "skills") : undefined;
  }
}

export const capabilityIdentity = (
  capability: Pick<MelodyExtension, "kind" | "path">,
) => `${capability.kind}:${capability.path}`;

export const mergeCapabilities = (
  preferred: MelodyExtension[],
  discovered: MelodyExtension[],
) => {
  const byIdentity = new Map<string, MelodyExtension>();
  for (const capability of [...preferred, ...discovered]) {
    const identity = capabilityIdentity(capability);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, capability);
    }
  }
  return [...byIdentity.values()];
};
