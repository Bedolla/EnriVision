/**
 * BOUNDED MEDIA URL FETCHER
 *
 * Downloads one http(s) media resource into a temporary directory so the
 * upload pipeline can treat it like any local file.
 *
 * Protections: 64 MiB size cap, 60 s timeout, SSRF guard (literal private
 * addresses rejected, DNS-resolved addresses rejected, per-hop validation of
 * up to 3 redirects), and an owned cleanup callback.
 *
 * @module shared/mediaUrlFetcher
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Result of one bounded media URL fetch.
 */
export interface MediaUrlFetchResult {
  /**
   * Absolute local path holding the downloaded bytes.
   */
  readonly localPath: string;

  /**
   * Content type reported by the server, without parameters (empty when absent).
   */
  readonly contentType: string;

  /**
   * Removes the owned temporary directory.
   */
  cleanup(): Promise<void>;
}

/**
 * Resolves hostnames to addresses for SSRF validation.
 */
export type HostAddressResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * Immutable media URL fetch result record.
 */
class MediaUrlFetchResultRecord implements MediaUrlFetchResult {
  /**
   * Creates one fetch result.
   *
   * @param localPath - Downloaded file path.
   * @param contentType - Reported content type.
   * @param cleanupCallback - Owned cleanup callback.
   */
  public constructor(
    public readonly localPath: string,
    public readonly contentType: string,
    private readonly cleanupCallback: () => Promise<void>,
  ) {}

  /**
   * @inheritdoc
   */
  public async cleanup(): Promise<void> {
    await this.cleanupCallback();
  }
}

/**
 * Downloads bounded http(s) media into a temporary directory.
 */
export class MediaUrlFetcher {
  /**
   * Maximum accepted download size in bytes.
   */
  private static readonly MAX_BYTES = 64 * 1024 * 1024;

  /**
   * Download timeout in milliseconds.
   */
  private static readonly TIMEOUT_MS = 60_000;

  /**
   * Maximum followed redirects (each hop re-validated).
   */
  private static readonly MAX_REDIRECTS = 3;

  /**
   * Fetch implementation (injectable for tests).
   */
  private readonly fetchImpl: typeof fetch;

  /**
   * Host address resolver (injectable for tests).
   */
  private readonly resolveHostAddresses: HostAddressResolver;

  /**
   * Creates one media URL fetcher.
   *
   * @param fetchImpl - Optional fetch override for tests.
   * @param resolveHostAddresses - Optional DNS resolver override for tests.
   */
  public constructor(fetchImpl?: typeof fetch, resolveHostAddresses?: HostAddressResolver) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.resolveHostAddresses =
      resolveHostAddresses ??
      (async (hostname: string): Promise<readonly string[]> => {
        const results: Array<{ address: string }> = await dnsLookup(hostname, { all: true });
        return results.map((result) => result.address);
      });
  }

  /**
   * Reports whether one input looks like an accepted http(s) URL.
   *
   * @param value - Raw path argument.
   * @returns True for http/https URLs.
   */
  public static isHttpUrl(value: string): boolean {
    return /^https?:\/\//iu.test(String(value ?? "").trim());
  }

  /**
   * Downloads one http(s) URL into a temporary directory.
   *
   * @param url - Absolute http(s) URL.
   * @returns Bounded fetch result with owned cleanup.
   * @throws Error when the destination is blocked, too large, or the download fails.
   */
  public async fetch(url: string): Promise<MediaUrlFetchResult> {
    let currentUrl: string = String(url ?? "").trim();
    if (!MediaUrlFetcher.isHttpUrl(currentUrl)) {
      throw new Error("Sólo se aceptan URLs http(s) en path/paths.");
    }

    const timeoutSignal: AbortSignal = AbortSignal.timeout(MediaUrlFetcher.TIMEOUT_MS);
    let response: Response = await this.requestValidated(currentUrl, timeoutSignal);

    for (let redirectCount = 0; redirectCount < MediaUrlFetcher.MAX_REDIRECTS; redirectCount += 1) {
      if (response.status < 301 || response.status > 308) {
        break;
      }
      const location: string | null = response.headers.get("location");
      if (!location) {
        break;
      }
      currentUrl = new URL(location, currentUrl).toString();
      if (!MediaUrlFetcher.isHttpUrl(currentUrl)) {
        throw new Error("La redirección apunta fuera de http(s).");
      }
      response = await this.requestValidated(currentUrl, timeoutSignal);
    }

    if (!response.ok) {
      throw new Error(`La URL respondió HTTP ${String(response.status)}.`);
    }

    const declaredLengthHeader: string | null = response.headers.get("content-length");
    if (
      declaredLengthHeader !== null &&
      Number(declaredLengthHeader) > MediaUrlFetcher.MAX_BYTES
    ) {
      throw new Error(`El archivo remoto excede el límite de 64 MiB.`);
    }

    const buffer: ArrayBuffer = await response.arrayBuffer();
    if (buffer.byteLength > MediaUrlFetcher.MAX_BYTES) {
      throw new Error(`El archivo remoto excede el límite de 64 MiB.`);
    }

    const contentType: string = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const temporaryDirectory: string = await mkdtemp(join(tmpdir(), "enrivision-url-"));
    const localPath: string = join(
      temporaryDirectory,
      this.deriveFileName(currentUrl, contentType),
    );

    try {
      await writeFile(localPath, Buffer.from(buffer));
    } catch (error: unknown) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw new Error(
        `No se pudo guardar la media descargada: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return new MediaUrlFetchResultRecord(localPath, contentType, async (): Promise<void> => {
      await rm(temporaryDirectory, { recursive: true, force: true });
    });
  }

  /**
   * Performs one fetch request after validating the destination addresses.
   *
   * @param url - Candidate URL (already normalized).
   * @param timeoutSignal - Timeout signal shared by every hop.
   * @returns Fetch response.
   * @throws Error when the hostname resolves to a blocked address or the request fails.
   */
  private async requestValidated(url: string, timeoutSignal: AbortSignal): Promise<Response> {
    await this.assertPublicDestination(url);
    try {
      return await this.fetchImpl(url, { signal: timeoutSignal, redirect: "manual" });
    } catch (error: unknown) {
      throw new Error(
        `La descarga de media falló: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Validates that the URL hostname is not a private/loopback/link-local target.
   *
   * @param url - Candidate URL.
   * @throws Error when a literal or resolved address is blocked.
   */
  private async assertPublicDestination(url: string): Promise<void> {
    const hostname: string = new URL(url).hostname.replace(/^\[|\]$/gu, "");
    if (hostname === "localhost") {
      throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas.");
    }
    if (isIP(hostname) !== 0) {
      this.assertPublicAddress(hostname);
      return;
    }
    const addresses: readonly string[] = await this.resolveHostAddresses(hostname);
    if (addresses.length === 0) {
      throw new Error("No se pudo resolver el host antes de descargar la media.");
    }
    for (const address of addresses) {
      this.assertPublicAddress(address);
    }
  }

  /**
   * Rejects private, loopback, link-local, and unspecified addresses.
   *
   * @param address - Literal IP address.
   * @throws Error when the address belongs to a blocked range.
   */
  private assertPublicAddress(address: string): void {
    const version: number = isIP(address);
    if (version === 4) {
      const octets: readonly number[] = address.split(".").map((part) => Number(part));
      const [first = 0, second = 0] = octets;
      const blocked: boolean =
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first >= 224;
      if (blocked) {
        throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas.");
      }
      return;
    }
    if (version === 6) {
      const normalized: string = address.toLowerCase();
      const blocked: boolean =
        normalized === "::" ||
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb");
      const mappedV4: string | null = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1] ?? null;
      if (mappedV4 !== null) {
        this.assertPublicAddress(mappedV4);
        return;
      }
      if (blocked) {
        throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas.");
      }
    }
  }

  /**
   * Derives one safe file name for the downloaded media.
   *
   * @param url - Source URL.
   * @param contentType - Reported content type.
   * @returns Bounded file name with a recognized extension.
   */
  private deriveFileName(url: string, contentType: string): string {
    const withoutQuery: string = url.split("?")[0] ?? url;
    const baseName: string = withoutQuery.split("/").pop() ?? "media";
    const sanitized: string = baseName.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 80);
    if (sanitized.length > 0 && /\.[A-Za-z0-9]{2,5}$/u.test(sanitized)) {
      return sanitized;
    }
    const extension: string = this.extensionForContentType(contentType);
    return `${sanitized.length > 0 ? sanitized : "media"}${extension}`;
  }

  /**
   * Resolves one default extension for a content type.
   *
   * @param contentType - Reported content type.
   * @returns Extension with leading dot.
   */
  private extensionForContentType(contentType: string): string {
    if (contentType.startsWith("image/")) return ".png";
    if (contentType.startsWith("video/")) return ".mp4";
    if (contentType.startsWith("audio/")) return ".mp3";
    if (contentType.includes("pdf")) return ".pdf";
    if (contentType.includes("tar")) return ".tar";
    return ".bin";
  }
}
