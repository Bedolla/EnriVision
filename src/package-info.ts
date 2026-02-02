import { createRequire } from "node:module";

type PackageJsonShape = { version?: unknown };

export class PackageInfoService {
  private readonly require: NodeRequire;
  private cachedVersion: string | null = null;

  public constructor() {
    this.require = createRequire(import.meta.url);
  }

  public getVersion(): string {
    if (this.cachedVersion !== null) return this.cachedVersion;

    const fallback = "0.0.0";
    try {
      const pkg = this.require("../package.json") as PackageJsonShape;
      const version = pkg.version;
      if (typeof version === "string" && version.trim().length > 0) {
        this.cachedVersion = version;
        return version;
      }
    } catch {
      // ignore
    }

    this.cachedVersion = fallback;
    return fallback;
  }
}

export const packageInfoService: PackageInfoService = new PackageInfoService();

