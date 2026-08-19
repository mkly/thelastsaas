import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

import type { Storage, StorageInput } from "./interface";

export interface S3StorageOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

function isMissingObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;

  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;

    const clientConfig: S3ClientConfig = {
      region: options.region ?? "us-east-1",
      forcePathStyle: options.forcePathStyle ?? false,
    };
    if (options.endpoint) clientConfig.endpoint = options.endpoint;
    if (options.accessKeyId && options.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      };
    }
    this.client = new S3Client(clientConfig);
  }

  /**
   * PutObject requires a known Content-Length, so a stream of unknown size
   * fails with NotImplemented; lib-storage's Upload streams it as a multipart
   * upload instead, holding only one part in memory at a time.
   */
  async write(key: string, content: StorageInput): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: Readable.from(content as AsyncIterable<Uint8Array>),
      },
    });
    await upload.done();
  }

  async read(key: string): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.Body?.transformToWebStream() ?? null;
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
