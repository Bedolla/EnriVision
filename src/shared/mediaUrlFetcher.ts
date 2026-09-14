/**
 * BOUNDED MEDIA URL FETCHER
 *
 * Downloads one http(s) media resource into a temporary directory so the
 * upload pipeline can treat it like any local file.
 *
 * Protections: 64 MiB size cap, 60 s timeout, 30 s stall watchdog (a hung
 * `reader.read()` aborts the download), SSRF guard (literal private
 * addresses rejected, DNS-resolved addresses rejected, per-hop validation of
 * up to 5 redirects), and an owned cleanup callback.
 *
 * @module shared/mediaUrlFetcher
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { extension as mimeExtension, lookup as mimeLookup } from "mime-types";

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
   * True when the local file extension was synthesized from the server
   * content type because the URL carried no usable extension.
   *
   * @remarks
   * Callers must prefer {@link contentType} over the extension-derived MIME
   * type when this flag is set; the synthesized extension is only a
   * filesystem hint and must never override the authoritative server type.
   */
  readonly extensionSynthesized: boolean;

  /**
   * Removes the owned temporary directory.
   */
  cleanup(): Promise<void>;
}

/**
 * Options for {@link MediaUrlFetcher.fetch}.
 */
export interface MediaUrlFetchOptions {
  /**
   * Cancellation signal (e.g., the MCP request `extra.signal`).
   */
  readonly signal?: AbortSignal;
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
   * @param extensionSynthesized - Whether the file extension was synthesized.
   * @param cleanupCallback - Owned cleanup callback.
   */
  public constructor(
    public readonly localPath: string,
    public readonly contentType: string,
    public readonly extensionSynthesized: boolean,
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
   * Stable size-cap marker embedded in every size-cap rejection message.
   *
   * Routers match on this marker (via {@link MediaUrlFetcher.isSizeCapError}),
   * never on the human-scale budget prose.
   */
  public static readonly URL_SIZE_CAP_MARKER = "[ENRIVISION_MEDIA_URL_SIZE_CAP]";

  /**
   * Reports whether an error is a client-side URL size-cap rejection.
   *
   * @param error - Unknown caught failure.
   * @returns True only for size-cap rejections carrying the stable marker.
   */
  public static isSizeCapError(error: unknown): boolean {
    return error instanceof Error && error.message.includes(MediaUrlFetcher.URL_SIZE_CAP_MARKER);
  }

  /**
   * Download timeout in milliseconds.
   */
  private static readonly TIMEOUT_MS = 60_000;

  /**
   * Maximum followed redirects (each hop re-validated, mirrors EnriCode).
   */
  private static readonly MAX_REDIRECTS = 5;

  /**
   * Redirect statuses that carry a `Location` hop.
   *
   * @remarks
   * Mirrors EnriCode `VisionAnalyzeMediaUrlFetcher.REDIRECT_STATUSES`: 304
   * (Not Modified, a cache validator without `Location` semantics), 305
   * (deprecated proxy directive), and 306 (unused since HTTP/1.1) never
   * start a new hop. Treating them as terminal keeps redirect-chasing
   * predictable and avoids method/body-rewrite surprises.
   */
  private static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set<number>([301, 302, 303, 307, 308]);

  /**
   * Stall watchdog in milliseconds: abort when no body bytes arrive within
   * this window (mirrors EnriCode `BODY_STALL_MS`).
   */
  private static readonly BODY_STALL_MS = 30_000;

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
   * Reports whether one served content type is analyzable media.
   *
   * @remarks
   * Exact-match set mirroring EnriCode `VisionAnalyzeMediaUrlFetcher`: Office
   * types never match by substring, so crafted types such as
   * `application/x-wordprocessing-evil` are rejected.
   *
   * @param contentType - Served content type without parameters.
   * @returns True for image, video, audio, PDF, and Office documents.
   */
  public static isAllowedMediaContentType(contentType: string): boolean {
    const normalized: string = String(contentType ?? "").trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }
    if (
      normalized.startsWith("image/")
      || normalized.startsWith("video/")
      || normalized.startsWith("audio/")
    ) {
      return true;
    }
    return ALLOWED_EXACT_CONTENT_TYPES.has(normalized);
  }

  /**
   * Reports whether a URL path carries a known media extension.
   *
   * @remarks
   * Fallback for servers that omit `content-type`: the extension is mapped
   * through the canonical `mime-types` table and the mapped type must pass
   * {@link isAllowedMediaContentType}, so this fallback can never drift
   * from the allowlist (mirrors EnriCode
   * `VisionAnalyzeMediaUrlFetcher.hasKnownMediaExtension`). A lying
   * extension still resolves through the authoritative server type
   * downstream, exactly like the EnriCode contract.
   *
   * @param url - Final URL (after redirects).
   * @returns True when the URL path ends with an extension mapping to analyzable media.
   */
  public static hasKnownMediaExtension(url: string): boolean {
    const withoutQuery: string = String(url ?? "").split(/[?#]/)[0] ?? "";
    const baseName: string = withoutQuery.split("/").pop() ?? "";
    const match: RegExpMatchArray | null = /\.([A-Za-z0-9]{1,10})$/u.exec(baseName);
    if (match === null) {
      return false;
    }
    const mapped: string | false = mimeLookup(match[1]!.toLowerCase());
    if (typeof mapped !== "string") {
      return false;
    }
    return MediaUrlFetcher.isAllowedMediaContentType(mapped.split(";", 1)[0]!.trim());
  }

  /**
   * Downloads one http(s) URL into a temporary directory.
   *
   * @remarks
   * The response body is streamed directly to disk so large downloads never
   * sit fully in memory; the 64 MiB cap is enforced incrementally while
   * streaming.
   *
   * @param url - Absolute http(s) URL.
   * @param options - Optional fetch options (cancellation signal).
   * @returns Bounded fetch result with owned cleanup.
   * @throws Error when the destination is blocked, too large, cancelled, or the download fails.
   */
  public async fetch(url: string, options?: MediaUrlFetchOptions): Promise<MediaUrlFetchResult> {
    const callerSignal: AbortSignal | undefined = options?.signal;
    if (callerSignal?.aborted) {
      throw new Error("La descarga de media fue cancelada por el cliente. / Media download cancelled by the client.");
    }

    let currentUrl: string = String(url ?? "").trim();
    if (!MediaUrlFetcher.isHttpUrl(currentUrl)) {
      throw new Error("Sólo se aceptan URLs http(s) en path/paths. / Only http(s) URLs are accepted in path/paths.");
    }

    const timeoutSignal: AbortSignal = AbortSignal.timeout(MediaUrlFetcher.TIMEOUT_MS);
    const combinedSignal: AbortSignal = callerSignal
      ? AbortSignal.any([timeoutSignal, callerSignal])
      : timeoutSignal;
    let response: Response = await this.requestValidated(currentUrl, combinedSignal, callerSignal);

    for (let redirectCount = 0; redirectCount < MediaUrlFetcher.MAX_REDIRECTS; redirectCount += 1) {
      if (!MediaUrlFetcher.REDIRECT_STATUSES.has(response.status)) {
        break;
      }
      const location: string | null = response.headers.get("location");
      if (!location) {
        throw new Error(`La redirección HTTP ${String(response.status)} no incluyó Location. / HTTP redirect ${String(response.status)} included no Location.`);
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`La redirección trae una URL inválida: '${location}'. / Redirect carries an invalid URL: '${location}'.`);
      }
      if (!MediaUrlFetcher.isHttpUrl(currentUrl)) {
        throw new Error("La redirección apunta fuera de http(s). / Redirect points outside http(s).");
      }
      // Release the intermediate hop body before following the redirect so
      // a hostile redirect chain with large bodies cannot retain a socket
      // and buffered bytes per hop.
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort only.
      }
      response = await this.requestValidated(currentUrl, combinedSignal, callerSignal);
    }

    // A redirect status surviving the loop means the chain is exhausted
    // (more than MAX_REDIRECTS hops, or a hop without Location): coach in
    // Spanish like EnriCode instead of surfacing a bare HTTP 3xx. The body
    // is always released first so the terminal hop never retains a socket.
    if (MediaUrlFetcher.REDIRECT_STATUSES.has(response.status)) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort only.
      }
      throw new Error(
        `La URL excede el máximo de ${String(MediaUrlFetcher.MAX_REDIRECTS)} redirecciones. / URL exceeds the maximum of ${String(MediaUrlFetcher.MAX_REDIRECTS)} redirects.`
      );
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort only.
      }
      throw new Error(`La URL respondió HTTP ${String(response.status)}. / URL answered HTTP ${String(response.status)}.`);
    }

    const declaredLengthHeader: string | null = response.headers.get("content-length");
    if (
      declaredLengthHeader !== null &&
      Number(declaredLengthHeader) > MediaUrlFetcher.MAX_BYTES
    ) {
      throw new Error(`El archivo remoto excede el límite de 64 MiB. / ${MediaUrlFetcher.URL_SIZE_CAP_MARKER} Remote file exceeds the 64 MiB limit.`);
    }

    const servedContentType: string = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    // When the server omits content-type, a known media extension in the
    // final URL rescues the download (mirrors EnriCode): only reject when
    // both signals fail. A disallowed served type (e.g. `text/html` behind
    // a `.png` URL) is blanked instead of trusted verbatim so the resolver
    // infers the type from the rescuing extension, exactly like the EnriCode
    // `trustedContentType === ""` contract; uploading `text/html` bytes as
    // media is never useful.
    if (
      !MediaUrlFetcher.isAllowedMediaContentType(servedContentType)
      && !MediaUrlFetcher.hasKnownMediaExtension(currentUrl)
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort only.
      }
      throw new Error(
        `La URL no sirvió un archivo de media válido (content-type: ${servedContentType.length > 0 ? servedContentType : "desconocido"}). Solo se aceptan imagen, video, audio, PDF y documentos de Office. / URL did not serve a valid media file (content-type: ${servedContentType.length > 0 ? servedContentType : "desconocido"}). Only image, video, audio, PDF, and Office documents are accepted.`,
      );
    }
    const contentType: string = MediaUrlFetcher.isAllowedMediaContentType(servedContentType)
      ? servedContentType
      : "";
    const temporaryDirectory: string = await mkdtemp(join(tmpdir(), "enrivision-url-"));
    const derived: DerivedMediaFileName = this.deriveFileName(currentUrl, contentType);
    const localPath: string = join(temporaryDirectory, derived.fileName);

    try {
      await this.streamBodyToFile(response, localPath, callerSignal);
    } catch (error: unknown) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (callerSignal?.aborted) {
        throw new Error("La descarga de media fue cancelada por el cliente. / Media download cancelled by the client.");
      }
      if (error instanceof Error && isOwnedDownloadError(error)) {
        throw error;
      }
      // Abort-shaped rejections that reach this boundary with no caller
      // cancellation are the overall 60 s deadline firing during the
      // request, redirect hops, or a null-body buffer read: surface the
      // Spanish-first timeout instead of Node's English abort text.
      if (
        error instanceof Error
        && (error.name === "AbortError" || error.name === "TimeoutError" || (error as { code?: unknown }).code === "ABORT_ERR")
      ) {
        throw new Error(
          `La descarga de media expiró: superó el límite de ${String(Math.round(MediaUrlFetcher.TIMEOUT_MS / 1_000))} s. / The media download timed out: it exceeded the ${String(Math.round(MediaUrlFetcher.TIMEOUT_MS / 1_000))} s limit.`,
        );
      }
      throw new Error(
        `La descarga de media falló: ${error instanceof Error ? error.message : String(error)} / Media download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return new MediaUrlFetchResultRecord(
      localPath,
      contentType,
      derived.extensionSynthesized,
      async (): Promise<void> => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
    );
  }

  /**
   * Streams one validated response body directly to a file.
   *
   * @param response - Validated fetch response.
   * @param localPath - Destination file path.
   * @param callerSignal - Optional caller cancellation signal.
   * @throws Error when the body exceeds the size cap, is cancelled, or cannot be written.
   */
  private async streamBodyToFile(
    response: Response,
    localPath: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (!response.body) {
      const buffer: ArrayBuffer = await response.arrayBuffer();
      if (buffer.byteLength > MediaUrlFetcher.MAX_BYTES) {
        throw new Error(`El archivo remoto excede el límite de 64 MiB. / ${MediaUrlFetcher.URL_SIZE_CAP_MARKER} Remote file exceeds the 64 MiB limit.`);
      }
      const fileStream = createWriteStream(localPath);
      const completion = finished(fileStream);
      fileStream.end(Buffer.from(buffer));
      try {
        await completion;
      } catch (error: unknown) {
        throw new Error(
          `No se pudo guardar la media descargada: ${error instanceof Error ? error.message : String(error)} / Could not save the downloaded media: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    const fileStream = createWriteStream(localPath);
    const completion = finished(fileStream);
    // The completion promise is only awaited on the success path; mark it
    // handled so error-path destroy() never surfaces as unhandled rejection.
    completion.catch(() => undefined);
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    try {
      let writtenBytes = 0;
      for (;;) {
        if (callerSignal?.aborted) {
          throw new Error("La descarga de media fue cancelada por el cliente. / Media download cancelled by the client.");
        }
        const read: Awaited<ReturnType<typeof reader.read>> = await MediaUrlFetcher.readWithStallWatchdog(
          reader,
          MediaUrlFetcher.BODY_STALL_MS,
        );
        if (read.done) {
          break;
        }
        writtenBytes += read.value.byteLength;
        if (writtenBytes > MediaUrlFetcher.MAX_BYTES) {
          throw new Error(`El archivo remoto excede el límite de 64 MiB. / ${MediaUrlFetcher.URL_SIZE_CAP_MARKER} Remote file exceeds the 64 MiB limit.`);
        }
        const chunk: Buffer = Buffer.from(read.value);
        const accepted: boolean = fileStream.write(chunk);
        if (!accepted) {
          await new Promise<void>((resolve, reject) => {
            fileStream.once("drain", () => resolve());
            fileStream.once("error", (streamError: Error) => reject(streamError));
          });
        }
      }
      fileStream.end();
      await completion;
    } catch (error: unknown) {
      fileStream.destroy();
      try {
        await reader.cancel();
      } catch {
        // Ignore reader-cancel failures; the original error wins.
      }
      if (error instanceof Error && isOwnedDownloadError(error)) {
        throw error;
      }
      // The combined signal only aborts early for the overall 60 s deadline
      // or caller cancellation (already handled above): a raw abort-shaped
      // rejection here means the deadline fired mid-body, so surface the
      // Spanish-first timeout instead of Node's English abort text and the
      // generic save-failure envelope.
      if (
        error instanceof Error
        && (error.name === "AbortError" || error.name === "TimeoutError" || (error as { code?: unknown }).code === "ABORT_ERR")
      ) {
        throw new Error(
          `La descarga de media expiró: superó el límite de ${String(Math.round(MediaUrlFetcher.TIMEOUT_MS / 1_000))} s. / The media download timed out: it exceeded the ${String(Math.round(MediaUrlFetcher.TIMEOUT_MS / 1_000))} s limit.`,
        );
      }
      throw new Error(
        `No se pudo guardar la media descargada: ${error instanceof Error ? error.message : String(error)} / Could not save the downloaded media: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Reads one body chunk guarded by the stall watchdog.
   *
   * @remarks
   * The global 60 s timeout alone cannot fire while one `reader.read()`
   * hangs forever; racing each read against `BODY_STALL_MS` aborts stalled
   * connections with a Spanish error.
   *
   * @param reader - Body reader.
   * @param stallMs - Stall budget in milliseconds.
   * @returns Read result.
   * @throws Error with an Spanish-first bilingual message when no bytes arrive within the stall budget.
   */
  private static async readWithStallWatchdog(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    stallMs: number,
  ): Promise<Awaited<ReturnType<typeof reader.read>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              void reader.cancel();
            } catch {
              // Best-effort only; the rejection below carries the error.
            }
            reject(new Error("La descarga de media se detuvo por inactividad (sin bytes durante 30 s). / Media download stalled (no bytes for 30 s)."));
          }, stallMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Performs one fetch request after validating the destination addresses.
   *
   * @remarks
   * Residual SSRF note (DNS-rebinding TOCTOU): the hostname is resolved and
   * validated here, but the HTTP stack re-resolves it when connecting, so a
   * hostile DNS could answer the second lookup with a private address. IP
   * pinning is intentionally not implemented: the global fetch/undici stack
   * used here exposes no connection-level IP pin without a custom
   * dispatcher, and every redirect hop is re-validated to keep the race
   * window minimal. This residual risk is accepted post-release, mirroring
   * EnriProxy's documented DNS-rebinding stance.
   *
   * @param url - Candidate URL (already normalized).
   * @param requestSignal - Timeout/cancellation signal shared by every hop.
   * @param callerSignal - Caller cancellation signal used to report bilingual cancel errors.
   * @returns Fetch response.
   * @throws Error when the hostname resolves to a blocked address or the request fails.
   */
  private async requestValidated(
    url: string,
    requestSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    await this.assertPublicDestination(url);
    try {
      return await this.fetchImpl(url, { signal: requestSignal, redirect: "manual" });
    } catch (error: unknown) {
      if (callerSignal?.aborted) {
        throw new Error("La descarga de media fue cancelada por el cliente. / Media download cancelled by the client.");
      }
      throw new Error(
        `La descarga de media falló: ${error instanceof Error ? error.message : String(error)} / Media download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Validates that the URL hostname is not a private/loopback/link-local target.
   *
   * @remarks
   * Non-canonical IPv4 literals (decimal `2130706433`, hex `0x7f.0.0.1`,
   * octal `0177.0.0.1`) are normalized to dotted quads before validation so
   * they cannot bypass the literal-IP check and reach DNS.
   *
   * @param url - Candidate URL.
   * @throws Error when a literal or resolved address is blocked.
   */
  private async assertPublicDestination(url: string): Promise<void> {
    let rawHostname: string;
    try {
      rawHostname = new URL(url).hostname.replace(/^\[|\]$/gu, "");
    } catch {
      throw new Error(`URL inválida: '${url}'. Use una URL http(s) completa. / Invalid URL: '${url}'. Use a complete http(s) URL.`);
    }
    const hostname: string = rawHostname.replace(/\.+$/u, "").toLowerCase();
    if (hostname === "localhost") {
      throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas. / Blocked destination: no localhost or private networks allowed.");
    }
    const normalized: string | null = MediaUrlFetcher.normalizeHostnameToIpAddress(hostname);
    if (normalized !== null) {
      this.assertPublicAddress(normalized);
      return;
    }
    if (isIP(hostname) !== 0) {
      this.assertPublicAddress(hostname);
      return;
    }
    const addresses: readonly string[] = await this.resolveHostAddresses(rawHostname);
    if (addresses.length === 0) {
      throw new Error("No se pudo resolver el host antes de descargar la media. / Could not resolve the host before downloading media.");
    }
    for (const address of addresses) {
      this.assertPublicAddress(address);
    }
  }

  /**
   * Normalizes a hostname to an IP address when it is a non-canonical IP literal.
   *
   * @remarks
   * Handles decimal (`2130706433`), hex (`0x7f.0.0.1`), and octal
   * (`0177.0.0.1`) IPv4 forms per `inet_aton` rules, plus IPv6
   * `::ffff:`-mapped forms in hex (`::ffff:7f00:1`) and full
   * (`0:0:0:0:0:ffff:127.0.0.1`) notation. Returns null for real hostnames
   * so they keep flowing to DNS validation.
   *
   * @param hostname - Lowercased hostname without brackets or trailing dots.
   * @returns Normalized IP address or null when not an IP literal.
   */
  private static normalizeHostnameToIpAddress(hostname: string): string | null {
    if (hostname.length === 0 || hostname.includes(":")) {
      return MediaUrlFetcher.normalizeMappedIpv6(hostname);
    }
    if (!/^[0-9a-z]+(\.[0-9a-z]+)*$/u.test(hostname)) {
      return null;
    }
    const parts: readonly string[] = hostname.split(".");
    if (parts.length < 1 || parts.length > 4) {
      return null;
    }
    const numbers: number[] = [];
    for (const part of parts) {
      const parsed: number | null = MediaUrlFetcher.parseIpv4Part(part);
      if (parsed === null) {
        return null;
      }
      numbers.push(parsed);
    }
    if (numbers.length === 1) {
      const value: number = numbers[0]!;
      if (value > 4294967295) {
        return null;
      }
      return `${String((value >>> 24) & 255)}.${String((value >>> 16) & 255)}.${String((value >>> 8) & 255)}.${String(value & 255)}`;
    }
    if (numbers.length === 2) {
      const first: number = numbers[0]!;
      const rest: number = numbers[1]!;
      if (first > 255 || rest > 16777215) {
        return null;
      }
      return `${String(first)}.${String((rest >>> 16) & 255)}.${String((rest >>> 8) & 255)}.${String(rest & 255)}`;
    }
    if (numbers.length === 3) {
      const first: number = numbers[0]!;
      const second: number = numbers[1]!;
      const rest: number = numbers[2]!;
      if (first > 255 || second > 255 || rest > 65535) {
        return null;
      }
      return `${String(first)}.${String(second)}.${String((rest >>> 8) & 255)}.${String(rest & 255)}`;
    }
    for (const octet of numbers) {
      if (octet > 255) {
        return null;
      }
    }
    return numbers.map((octet: number): string => String(octet)).join(".");
  }

  /**
   * Parses one IPv4 address part accepting decimal, hex, and octal forms.
   *
   * @param part - Raw address part.
   * @returns Parsed value or null when not a numeric part.
   */
  private static parseIpv4Part(part: string): number | null {
    if (/^0x[0-9a-f]+$/u.test(part)) {
      const parsed: number = Number.parseInt(part, 16);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    if (/^0[0-9]+$/u.test(part)) {
      if (!/^0[0-7]*$/u.test(part)) {
        return null;
      }
      const parsed: number = Number.parseInt(part, 8);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    if (/^[0-9]+$/u.test(part)) {
      const parsed: number = Number.parseInt(part, 10);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * Normalizes IPv6 `::ffff:`-mapped literals to their embedded IPv4 address.
   *
   * @remarks
   * Covers the compact hex form (`::ffff:7f00:1`), the compact dotted form
   * (`::ffff:127.0.0.1`), and the full zero-expanded forms
   * (`0:0:0:0:0:ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`).
   *
   * @param hostname - Lowercased hostname.
   * @returns Embedded IPv4 dotted quad or null when not a mapped literal.
   */
  private static normalizeMappedIpv6(hostname: string): string | null {
    const compactHex: RegExpMatchArray | null = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(hostname);
    if (compactHex !== null) {
      const high: number = Number.parseInt(compactHex[1]!, 16);
      const low: number = Number.parseInt(compactHex[2]!, 16);
      return `${String((high >>> 8) & 255)}.${String(high & 255)}.${String((low >>> 8) & 255)}.${String(low & 255)}`;
    }
    const fullHex: RegExpMatchArray | null = /^0(?::0){4}:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(hostname);
    if (fullHex !== null) {
      const high: number = Number.parseInt(fullHex[1]!, 16);
      const low: number = Number.parseInt(fullHex[2]!, 16);
      return `${String((high >>> 8) & 255)}.${String(high & 255)}.${String((low >>> 8) & 255)}.${String(low & 255)}`;
    }
    const fullDotted: RegExpMatchArray | null = /^0(?::0){4}:ffff:((?:\d{1,3}\.){3}\d{1,3})$/u.exec(hostname);
    if (fullDotted !== null) {
      return fullDotted[1]!;
    }
    return null;
  }

  /**
   * Expands one IPv6 literal into eight hex groups.
   *
   * @remarks
   * Returns null for dotted-quad tails (handled by the compatible/mapped
   * helpers), malformed group counts, and non-hex groups, so callers only
   * ever judge fully-validated literals.
   *
   * @param normalized - Lowercased IPv6 literal without a zone id.
   * @returns Eight lowercase hex groups, or null when not parseable.
   */
  private static expandIpv6Groups(normalized: string): string[] | null {
    if (normalized.includes(".")) {
      return null;
    }
    const halves: string[] = normalized.split("::");
    if (halves.length > 2) {
      return null;
    }
    const left: string[] = halves[0]!.length === 0 ? [] : halves[0]!.split(":");
    const right: string[] =
      halves.length === 2 ? (halves[1]!.length === 0 ? [] : halves[1]!.split(":")) : [];
    if (halves.length === 1) {
      return left.length === 8 ? left : null;
    }
    const missing: number = 8 - left.length - right.length;
    if (missing < 1) {
      return null;
    }
    const groups: string[] = [...left, ...new Array<string>(missing).fill("0"), ...right];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) {
        return null;
      }
    }
    return groups;
  }

  /**
   * Reports whether one IPv6 literal is unspecified or loopback in any spelling.
   *
   * @remarks
   * The exact-only `"::"` / `"::1"` comparison misses zero-expanded
   * spellings (`0:0:0:0:0:0:0:0`, `0:0:0:0:0:0:0:1`) and leading-zero
   * variants (`::01`): expanding first closes the SSRF loopback bypass.
   *
   * @param normalized - Lowercased IPv6 literal.
   * @returns True for `::/128` and `::1/128` in any spelling.
   */
  private static isUnspecifiedOrLoopbackV6(normalized: string): boolean {
    const groups: string[] | null = MediaUrlFetcher.expandIpv6Groups(normalized);
    if (groups === null) {
      return normalized === "::" || normalized === "::1";
    }
    if (groups.every((group: string): boolean => Number.parseInt(group, 16) === 0)) {
      return true;
    }
    return groups.slice(0, 7).every((group: string): boolean => Number.parseInt(group, 16) === 0)
      && Number.parseInt(groups[7]!, 16) === 1;
  }

  /**
   * Extracts the embedded IPv4 address from a deprecated IPv4-compatible literal.
   *
   * @remarks
   * `::127.0.0.1` (and its zero-expanded `0:0:0:0:0:0:127.0.0.1` form)
   * carries no `ffff` marker, so the mapped-address helper ignores it and
   * the quad would sail through as "public". Recursing into the IPv4
   * validator closes the bypass.
   *
   * @param normalized - Lowercased IPv6 literal.
   * @returns Embedded IPv4 dotted quad or null when not a compatible literal.
   */
  private static extractCompatibleV4(normalized: string): string | null {
    const compact: RegExpMatchArray | null = /^::((?:\d{1,3}\.){3}\d{1,3})$/u.exec(normalized);
    if (compact !== null) {
      return compact[1]!;
    }
    const expanded: RegExpMatchArray | null = /^0(?::0){5}:((?:\d{1,3}\.){3}\d{1,3})$/u.exec(normalized);
    if (expanded !== null) {
      return expanded[1]!;
    }
    return null;
  }

  /**
   * Extracts the embedded IPv4 address from a zero-prefixed hex literal.
   *
   * @remarks
   * `::7f00:1` (and expanded `0:0:0:0:0:0:7f00:1`) embeds `127.0.0.1` in
   * the low 32 bits with neither dots nor an `ffff` marker, so neither the
   * compatible helper nor the mapped helper fires. Treating the low 32
   * bits of any 96-bit-zero literal as IPv4 closes the bypass; literals
   * with a nonzero prefix (including `::ffff:`-mapped) return null.
   *
   * @param normalized - Lowercased IPv6 literal.
   * @returns Embedded IPv4 dotted quad or null when the prefix is nonzero.
   */
  private static extractZeroPrefixedV4(normalized: string): string | null {
    const groups: string[] | null = MediaUrlFetcher.expandIpv6Groups(normalized);
    if (groups === null) {
      return null;
    }
    for (let index = 0; index < 6; index += 1) {
      if (Number.parseInt(groups[index]!, 16) !== 0) {
        return null;
      }
    }
    const high: number = Number.parseInt(groups[6]!, 16);
    const low: number = Number.parseInt(groups[7]!, 16);
    return `${String((high >>> 8) & 255)}.${String(high & 255)}.${String((low >>> 8) & 255)}.${String(low & 255)}`;
  }

  /**
   * Extracts the embedded IPv4 address from a normalized IPv6 literal.
   *
   * @param normalized - Lowercased IPv6 literal.
   * @returns Embedded IPv4 dotted quad or undefined when not mapped.
   */
  private static extractMappedV4(normalized: string): string | undefined {
    const compactDotted: RegExpMatchArray | null = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/u.exec(normalized);
    if (compactDotted !== null) {
      return compactDotted[1];
    }
    return MediaUrlFetcher.normalizeMappedIpv6(normalized) ?? undefined;
  }

  /**
   * Extracts the embedded IPv4 address from a NAT64 `64:ff9b::/96` literal.
   *
   * @remarks
   * On NAT64 networks `64:ff9b::7f00:1` routes to `127.0.0.1`, so the
   * literal sails through prefix tests as "public". Judging the embedded
   * quad as IPv4 closes the bypass (parity with EnriCode
   * `Nat64AddressGuard.extractNat64EmbeddedIpv4`).
   *
   * @param normalized - Lowercased IPv6 literal.
   * @returns Embedded IPv4 dotted quad or null when not a NAT64 literal.
   */
  private static extractNat64V4(normalized: string): string | null {
    const dotted: RegExpMatchArray | null = /^64:ff9b::((?:\d{1,3}\.){3}\d{1,3})$/u.exec(normalized);
    if (dotted !== null) {
      return dotted[1]!;
    }
    const groups: string[] | null = MediaUrlFetcher.expandIpv6Groups(normalized);
    if (groups === null) {
      return null;
    }
    if (
      Number.parseInt(groups[0]!, 16) !== 0x64
      || Number.parseInt(groups[1]!, 16) !== 0xff9b
      || Number.parseInt(groups[2]!, 16) !== 0
      || Number.parseInt(groups[3]!, 16) !== 0
      || Number.parseInt(groups[4]!, 16) !== 0
      || Number.parseInt(groups[5]!, 16) !== 0
    ) {
      return null;
    }
    const high: number = Number.parseInt(groups[6]!, 16);
    const low: number = Number.parseInt(groups[7]!, 16);
    return `${String((high >>> 8) & 255)}.${String(high & 255)}.${String((low >>> 8) & 255)}.${String(low & 255)}`;
  }

  /**
   * Rejects private, loopback, link-local, multicast, and reserved addresses.
   *
   * @remarks
   * Documentation TEST-NET ranges (`192.0.2.0/24`, `198.51.100.0/24`,
   * `203.0.113.0/24`) intentionally stay allowed: they are publicly routed
   * test fixtures, never host-local media, and blocking them would break
   * legitimate fixture URLs.
   *
   * @param address - Literal IP address.
   * @throws Error when the address belongs to a blocked range.
   */
  private assertPublicAddress(address: string): void {
    const version: number = isIP(address);
    if (version === 4) {
      const octets: readonly number[] = address.split(".").map((part) => Number(part));
      const [first = 0, second = 0, third = 0] = octets;
      const blocked: boolean =
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 0 && third === 0) ||
        (first === 192 && second === 168) ||
        (first === 198 && second >= 18 && second <= 19) ||
        first >= 224;
      if (blocked) {
        throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas. / Blocked destination: no localhost or private networks allowed.");
      }
      return;
    }
    if (version === 6) {
      const normalized: string = address.toLowerCase();
      // Deprecated compatible literals (::127.0.0.1, ::7f00:1, expanded
      // spellings) hide an IPv4 quad with no ffff marker: judge the
      // embedded quad as IPv4 before any prefix test.
      const compatibleV4: string | null = MediaUrlFetcher.extractCompatibleV4(normalized)
        ?? MediaUrlFetcher.extractZeroPrefixedV4(normalized)
        ?? MediaUrlFetcher.extractNat64V4(normalized);
      if (compatibleV4 !== null) {
        this.assertPublicAddress(compatibleV4);
        return;
      }
      const blocked: boolean =
        MediaUrlFetcher.isUnspecifiedOrLoopbackV6(normalized) ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb") ||
        normalized.startsWith("ff");
      const mappedV4: string | null = MediaUrlFetcher.extractMappedV4(normalized) ?? null;
      if (mappedV4 !== null) {
        this.assertPublicAddress(mappedV4);
        return;
      }
      if (blocked) {
        throw new Error("Destino bloqueado: no se permiten hosts locales ni redes privadas. / Blocked destination: no localhost or private networks allowed.");
      }
    }
  }

  /**
   * Derives one safe file name for the downloaded media.
   *
   * @param url - Source URL.
   * @param contentType - Reported content type.
   * @returns Bounded file name with a recognized extension plus whether the extension was synthesized.
   */
  private deriveFileName(url: string, contentType: string): DerivedMediaFileName {
    const withoutQuery: string = url.split(/[?#]/)[0] ?? url;
    const baseName: string = withoutQuery.split("/").pop() ?? "media";
    const sanitized: string = baseName.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 80);
    if (sanitized.length > 0 && /\.[A-Za-z0-9]{2,5}$/u.test(sanitized)) {
      return { fileName: sanitized, extensionSynthesized: false };
    }
    const extension: string = this.extensionForContentType(contentType);
    return {
      fileName: `${sanitized.length > 0 ? sanitized : "media"}${extension}`,
      extensionSynthesized: true,
    };
  }

  /**
   * Resolves one precise extension for a content type.
   *
   * @remarks
   * The exact `mime-types` mapping wins (e.g., `image/webp` yields `.webp`,
   * never the generic `.png`) so the synthesized extension can never shadow
   * the authoritative server content type downstream.
   *
   * @param contentType - Reported content type.
   * @returns Extension with leading dot.
   */
  private extensionForContentType(contentType: string): string {
    const normalized: string = contentType.trim().toLowerCase();
    if (normalized && normalized !== "application/octet-stream") {
      const mapped: string | false = mimeExtension(normalized);
      if (typeof mapped === "string" && /^[a-z0-9]+$/iu.test(mapped)) {
        return `.${mapped.toLowerCase()}`;
      }
    }
    if (normalized.startsWith("image/")) return ".png";
    if (normalized.startsWith("video/")) return ".mp4";
    if (normalized.startsWith("audio/")) return ".mp3";
    if (normalized.includes("pdf")) return ".pdf";
    return ".bin";
  }
}

/**
 * Exact-match Office/document content types accepted for analysis.
 *
 * @remarks
 * Mirrors EnriCode `VisionAnalyzeMediaUrlFetcher`: never extend this set
 * with substring matching, so crafted types cannot bypass the filter.
 */
const ALLOWED_EXACT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/rtf",
  "text/csv",
  "text/plain",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/**
 * File name derived for one downloaded media URL.
 */
interface DerivedMediaFileName {
  /**
   * Bounded file name with a recognized extension.
   */
  readonly fileName: string;

  /**
   * True when the extension was synthesized from the content type.
   */
  readonly extensionSynthesized: boolean;
}

/**
 * Reports whether an error message is already an owned bilingual download error.
 *
 * @param error - Error to inspect.
 * @returns True when the message must propagate unchanged.
 */
function isOwnedDownloadError(error: Error): boolean {
  return (
    error.message.includes(MediaUrlFetcher.URL_SIZE_CAP_MARKER)
    || error.message.startsWith("Media download")
    || error.message.startsWith("Could not save the downloaded media")
    || error.message.startsWith("El archivo remoto")
    || error.message.startsWith("La descarga de media fue cancelada")
    || error.message.startsWith("La descarga de media se detuvo")
    || error.message.startsWith("La descarga de media expiró")
    || error.message.startsWith("No se pudo guardar la media descargada")
  );
}
