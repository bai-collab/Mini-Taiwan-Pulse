/**
 * Authenticated PMTiles source dedicated to the private coral archive.
 *
 * `mapbox-pmtiles` creates `new PMTiles(url)` internally, whose FetchSource cannot
 * refresh Authorization headers.  This source replaces that instance before Mapbox
 * calls `load()`.  Do not register it for public PMTiles sources.
 */
import maplibregl from "maplibre-gl";
import type { GetResourceResponse } from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";

export const PRIVATE_CORAL_PMTILES_SOURCE_TYPE = "vector";
export const MAX_PRIVATE_CORAL_RANGE_BYTES = 8 * 1024 * 1024;
export const PRIVATE_CORAL_REQUEST_TIMEOUT_MS = 30_000;

export type PrivateCoralPmtilesOptions = {
  url: string;
  /** Called for every HTTP Range request, so expired credentials are never retained. */
  getToken?: () => Promise<string | null | undefined> | string | null | undefined;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function httpError(message: string, status?: number): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) error.status = status;
  return error;
}

function linkAbortSignal(external: AbortSignal | undefined, local: AbortController): () => void {
  if (!external) return () => undefined;
  const abort = () => local.abort(external.reason);
  if (external.aborted) abort();
  else external.addEventListener("abort", abort, { once: true });
  return () => external.removeEventListener("abort", abort);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Private coral PMTiles request aborted", "AbortError");
}

async function awaitAbortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** A per-mounted-source PMTiles Source; it is intentionally never shared by URL. */
export class PrivateCoralFetchSource implements Source {
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(
    readonly url: string,
    private readonly getToken: NonNullable<PrivateCoralPmtilesOptions["getToken"]>,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  getKey(): string {
    // This instance owns a new PMTiles cache. The URL is only a key inside that instance,
    // therefore entries can never be re-used by another account's mounted source.
    return this.url;
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async getBytes(offset: number, length: number, passedSignal?: AbortSignal): Promise<RangeResponse> {
    if (this.disposed) throw httpError("Private coral PMTiles source was disposed");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_PRIVATE_CORAL_RANGE_BYTES) {
      throw httpError(`Private coral PMTiles refused invalid Range ${offset}+${length}`);
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const unlinkAbort = linkAbortSignal(passedSignal, controller);
    const timeout = setTimeout(
      () => controller.abort(httpError(`Private coral PMTiles request timed out after ${PRIVATE_CORAL_REQUEST_TIMEOUT_MS}ms`)),
      PRIVATE_CORAL_REQUEST_TIMEOUT_MS,
    );
    try {
      const token = await awaitAbortable(Promise.resolve().then(() => this.getToken()), controller.signal);
      if (this.disposed) throw httpError("Private coral PMTiles source was disposed");
      if (!token?.trim()) throw httpError("Private coral PMTiles token is unavailable", 401);
      const end = offset + length - 1;
      const response = await awaitAbortable(this.fetchFn(this.url, {
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=${offset}-${end}`,
        },
      }), controller.signal);
      if (this.disposed) {
        cancelResponseBody(response);
        throw httpError("Private coral PMTiles source was disposed");
      }
      if (response.status === 401 || response.status === 403) {
        // Never read the body: no authenticated partial response is handed to Mapbox.
        cancelResponseBody(response);
        throw httpError(`Private coral PMTiles access denied (${response.status})`, response.status);
      }
      if (response.status !== 206) {
        cancelResponseBody(response);
        throw httpError(`Private coral PMTiles requires HTTP 206, received ${response.status}`, response.status);
      }

      const expectedRange = `bytes ${offset}-${end}/`;
      const contentRange = response.headers.get("Content-Range");
      if (!contentRange?.startsWith(expectedRange) || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) {
        cancelResponseBody(response);
        throw httpError(`Private coral PMTiles received invalid Content-Range: ${contentRange ?? "missing"}`);
      }
      const data = await response.arrayBuffer();
      if (this.disposed) throw httpError("Private coral PMTiles source was disposed");
      if (data.byteLength !== length) {
        throw httpError(`Private coral PMTiles range length mismatch: expected ${length}, received ${data.byteLength}`);
      }
      return {
        data,
        etag: response.headers.get("ETag") || undefined,
        cacheControl: response.headers.get("Cache-Control") || undefined,
        expires: response.headers.get("Expires") || undefined,
      };
    } finally {
      clearTimeout(timeout);
      unlinkAbort();
      this.controllers.delete(controller);
    }
  }
}

type PrivateProtocolEntry = {
  source: PrivateCoralFetchSource;
  protocol: Protocol;
};

const privateProtocolEntries = new Map<string, PrivateProtocolEntry>();
let privateProtocolRegistered = false;
let privateProtocolSequence = 0;

function registerPrivateCoralProtocolOnce(): void {
  if (privateProtocolRegistered) return;
  privateProtocolRegistered = true;
  maplibregl.addProtocol("private-coral", async (request, abortController): Promise<GetResourceResponse<unknown>> => {
    const match = request.url.match(/^private-coral:\/\/([^/]+)(\/.*)?$/);
    const key = match?.[1];
    const entry = key ? privateProtocolEntries.get(key) : undefined;
    if (!entry) throw httpError("Private coral PMTiles source is unavailable", 410);
    const delegatedRequest = {
      ...request,
      url: `pmtiles://${entry.source.getKey()}${match?.[2] ?? ""}`,
    };
    // pmtiles Protocol supports the same request/AbortController bridge used by
    // MapLibre. Keep the cast local because its v3 compatibility declaration is broad.
    return await (entry.protocol.tile as unknown as (
      params: typeof delegatedRequest,
      controller: AbortController,
    ) => Promise<GetResourceResponse<unknown>>)(delegatedRequest, abortController);
  });
}

/** 建立一個只屬於目前帳號的 private-coral:// source URL。 */
export function createPrivateCoralPmtilesUrl(options: PrivateCoralPmtilesOptions): {
  url: string;
  dispose: () => void;
} {
  if (!options.getToken) throw httpError("Private coral PMTiles requires getToken", 401);
  registerPrivateCoralProtocolOnce();
  const source = new PrivateCoralFetchSource(options.url, options.getToken);
  const protocol = new Protocol({ metadata: true });
  protocol.add(new PMTiles(source));
  const key = `coral-${++privateProtocolSequence}`;
  privateProtocolEntries.set(key, { source, protocol });
  return {
    url: `private-coral://${key}`,
    dispose: () => {
      const entry = privateProtocolEntries.get(key);
      if (!entry) return;
      entry.source.dispose();
      privateProtocolEntries.delete(key);
    },
  };
}

/** 舊呼叫點相容入口；實際 protocol 會在 createPrivateCoralPmtilesUrl 時建立。 */
export function registerPrivateCoralSourceOnce(): void {
  registerPrivateCoralProtocolOnce();
}

export const __test__ = { PrivateCoralFetchSource, linkAbortSignal };
