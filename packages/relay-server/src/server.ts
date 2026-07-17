import express, { type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { ParsedQs } from "qs";

interface UploadSession {
  totalChunks?: number;
  chunks: Map<number, Buffer>;
  completeDelta?: Buffer;
}

export interface RelayServerOptions {
  maxChunkBytes?: string;
}

export interface UploadStatusResponse {
  sessionId: string;
  receivedChunks: number[];
  highestContiguousChunkIndex: number;
  totalChunks: number | null;
  complete: boolean;
}

function parseNonNegativeInteger(value: string | string[] | undefined, name: string): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveInteger(value: string | string[] | undefined, name: string): number {
  const parsed = parseNonNegativeInteger(value, name);

  if (parsed === 0) {
    throw new Error(`${name} must be greater than zero`);
  }

  return parsed;
}

function getStringQuery(value: string | ParsedQs | (string | ParsedQs)[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function getHighestContiguousChunkIndex(chunks: Map<number, Buffer>): number {
  let index = 0;

  while (chunks.has(index)) {
    index += 1;
  }

  return index - 1;
}

function getStatus(sessionId: string, session?: UploadSession): UploadStatusResponse {
  const receivedChunks = session ? [...session.chunks.keys()].sort((a, b) => a - b) : [];

  return {
    sessionId,
    receivedChunks,
    highestContiguousChunkIndex: session ? getHighestContiguousChunkIndex(session.chunks) : -1,
    totalChunks: session?.totalChunks ?? null,
    complete: Boolean(session?.completeDelta),
  };
}

export function createRelayServer(options: RelayServerOptions = {}) {
  const app = express();
  const sessions = new Map<string, UploadSession>();

  app.post(
    "/sync/:sessionId/upload",
    express.raw({ type: "*/*", limit: options.maxChunkBytes ?? "25mb" }),
    (req: Request, res: Response) => {
      try {
        const chunkIndex = parseNonNegativeInteger(req.header("x-chunk-index"), "x-chunk-index");
        const totalChunks = parsePositiveInteger(req.header("x-total-chunks"), "x-total-chunks");
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);

        if (chunkIndex >= totalChunks) {
          res.status(400).json({ error: "x-chunk-index must be less than x-total-chunks" });
          return;
        }

        const session =
          sessions.get(req.params.sessionId) ??
          ({
            chunks: new Map<number, Buffer>(),
          } satisfies UploadSession);

        if (session.totalChunks !== undefined && session.totalChunks !== totalChunks) {
          res.status(409).json({ error: "total chunk count changed for this session" });
          return;
        }

        session.totalChunks = totalChunks;
        session.chunks.set(chunkIndex, body);
        sessions.set(req.params.sessionId, session);

        if (session.chunks.size === totalChunks) {
          const orderedChunks = Array.from({ length: totalChunks }, (_, index) =>
            session.chunks.get(index),
          );

          if (orderedChunks.every((chunk): chunk is Buffer => Boolean(chunk))) {
            session.completeDelta = Buffer.concat(orderedChunks);
          }
        }

        res.json(getStatus(req.params.sessionId, session));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "invalid upload" });
      }
    },
  );

  app.get("/sync/:sessionId/upload-status", (req: Request, res: Response) => {
    res.json(getStatus(req.params.sessionId, sessions.get(req.params.sessionId)));
  });

  app.get("/sync/:sessionId/download", (req: Request, res: Response) => {
    try {
      const session = sessions.get(req.params.sessionId);

      if (!session?.completeDelta) {
        res.status(404).json({ error: "complete delta is not available for this session" });
        return;
      }

      const chunkSize = parsePositiveInteger(getStringQuery(req.query.chunkSize), "chunkSize");
      const fromChunkQuery = getStringQuery(req.query.fromChunk);
      const fromChunk = fromChunkQuery
        ? parseNonNegativeInteger(fromChunkQuery, "fromChunk")
        : 0;
      const totalChunks = Math.ceil(session.completeDelta.length / chunkSize);

      if (fromChunk >= totalChunks) {
        res.status(204).end();
        return;
      }

      const start = fromChunk * chunkSize;
      const end = Math.min(start + chunkSize, session.completeDelta.length);
      const chunk = session.completeDelta.subarray(start, end);

      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("x-chunk-index", String(fromChunk));
      res.setHeader("x-total-chunks", String(totalChunks));
      res.setHeader("x-next-chunk-index", String(fromChunk + 1));
      res.setHeader("x-is-last-chunk", String(fromChunk + 1 >= totalChunks));
      res.send(chunk);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "invalid download" });
    }
  });

  return app;
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createRelayServer().listen(port, () => {
    const address = server.address() as AddressInfo;
    console.log(`setu relay server listening on http://127.0.0.1:${address.port}`);
  });
}
