export interface TransportOptions {
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  initialBackoffMs?: number;
  onUploadChunk?: (details: ChunkTransferDetails) => void;
  onDownloadChunk?: (details: ChunkTransferDetails) => void;
}

interface UploadStatusResponse {
  receivedChunks: number[];
}

export interface ChunkTransferDetails {
  sessionId: string;
  chunkIndex: number;
  bytes: number;
}

const defaultRelayUrl = "http://127.0.0.1:3000";

export const DEFAULT_CHUNK_SIZE = 4096;

function getRelayUrl(options?: TransportOptions): string {
  return (
    options?.relayUrl ??
    process.env.CAUSEWAY_RELAY_URL ??
    process.env.SETU_RELAY_URL ??
    defaultRelayUrl
  ).replace(/\/$/, "");
}

function getFetch(options?: TransportOptions): typeof fetch {
  return options?.fetchImpl ?? globalThis.fetch;
}

function splitBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  const chunks: Buffer[] = [];

  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }

  return chunks;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options?: TransportOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const initialBackoffMs = options?.initialBackoffMs ?? 50;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      await sleep(initialBackoffMs * 2 ** attempt);
    }
  }

  throw lastError;
}

async function getUploadStatus(
  sessionId: string,
  options?: TransportOptions,
): Promise<UploadStatusResponse> {
  const response = await withRetry(
    () =>
      getFetch(options)(
        `${getRelayUrl(options)}/sync/${encodeURIComponent(sessionId)}/upload-status`,
      ),
    options,
  );

  if (!response.ok) {
    throw new Error(`upload status failed with HTTP ${response.status}`);
  }

  return (await response.json()) as UploadStatusResponse;
}

export async function uploadDelta(
  sessionId: string,
  encodedDelta: Buffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options?: TransportOptions,
): Promise<void> {
  const chunks = splitBuffer(encodedDelta, chunkSize);
  const status = await getUploadStatus(sessionId, options);
  const receivedChunks = new Set(status.receivedChunks);
  const fetchImpl = getFetch(options);
  const relayUrl = getRelayUrl(options);

  // HTTP chunks are deliberate here: WebSockets fully die on a bad packet sequence and
  // require a fresh reconnect plus handshake, while individual HTTP chunk requests can
  // be retried without losing already-confirmed progress on lossy 2G-style links.
  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (receivedChunks.has(chunkIndex)) {
      continue;
    }

    await withRetry(async () => {
      const response = await fetchImpl(
        `${relayUrl}/sync/${encodeURIComponent(sessionId)}/upload`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-chunk-index": String(chunkIndex),
            "x-total-chunks": String(chunks.length),
          },
          body: new Uint8Array(chunk),
        },
      );

      if (!response.ok) {
        throw new Error(`upload chunk ${chunkIndex} failed with HTTP ${response.status}`);
      }

      options?.onUploadChunk?.({
        sessionId,
        chunkIndex,
        bytes: chunk.byteLength,
      });
    }, options);
  }
}

export async function downloadDelta(
  sessionId: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options?: TransportOptions,
): Promise<Buffer> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  const fetchImpl = getFetch(options);
  const relayUrl = getRelayUrl(options);
  const chunks: Buffer[] = [];
  let nextChunkIndex = 0;
  let totalChunks: number | null = null;

  while (totalChunks === null || nextChunkIndex < totalChunks) {
    const chunk = await withRetry(async () => {
      const url = new URL(`${relayUrl}/sync/${encodeURIComponent(sessionId)}/download`);
      url.searchParams.set("fromChunk", String(nextChunkIndex));
      url.searchParams.set("chunkSize", String(chunkSize));

      const response = await fetchImpl(url);

      if (!response.ok) {
        throw new Error(`download chunk ${nextChunkIndex} failed with HTTP ${response.status}`);
      }

      const totalChunksHeader = response.headers.get("x-total-chunks");
      const chunkIndexHeader = response.headers.get("x-chunk-index");

      if (!totalChunksHeader || !chunkIndexHeader) {
        throw new Error("download response was missing chunk metadata");
      }

      const chunkIndex = Number(chunkIndexHeader);

      if (chunkIndex !== nextChunkIndex) {
        throw new Error(`expected chunk ${nextChunkIndex}, received chunk ${chunkIndex}`);
      }

      totalChunks = Number(totalChunksHeader);
      const chunk = Buffer.from(await response.arrayBuffer());

      options?.onDownloadChunk?.({
        sessionId,
        chunkIndex,
        bytes: chunk.byteLength,
      });

      return chunk;
    }, options);

    chunks.push(chunk);
    nextChunkIndex += 1;
  }

  return Buffer.concat(chunks);
}
