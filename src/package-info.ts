/**
 * PACKAGE INFO
 *
 * Reads the published package version from `package.json` with an
 * injectable-free `createRequire` lookup and a safe fallback.
 *
 * @module package-info
 */

import { createRequire } from "node:module";

/**
 * Minimal shape of the fields read from `package.json`.
 */
type PackageJsonShape = { version?: unknown };

/**
 * Provides the current package version.
 */
export class PackageInfoService {
  /**
   * Node require function anchored at this module.
   */
  private readonly require: NodeRequire;

  /**
   * Cached version once resolved.
   */
  private cachedVersion: string | null = null;

  /**
   * Creates a new {@link PackageInfoService}.
   */
  public constructor() {
    this.require = createRequire(import.meta.url);
  }

  /**
   * Returns the package version from `package.json`.
   *
   * @returns Version string, or `0.0.0` when unreadable.
   */
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

/**
 * Shared package info service instance.
 */
export const packageInfoService: PackageInfoService = new PackageInfoService();
