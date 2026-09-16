// Объектное хранилище S3 (раздел 5 server-spec.md): локально MinIO, на VPS — Timeweb/Selectel.
// Бакет приватный, наружу — только подписанные ссылки (шаг 3.3). Здесь — клиент и проверка.
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { withTimeout } from './redis.js';

export interface Storage {
  client: S3Client;
  bucket: string;
}

export function makeStorage(cfg: Config): Storage {
  const client = new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    forcePathStyle: cfg.s3.forcePathStyle,
    credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
    requestHandler: { requestTimeout: 5_000, connectionTimeout: 3_000 }
  });
  return { client, bucket: cfg.s3.bucket };
}

/** Проверка для /healthz: бакет существует и доступен с нашими ключами. */
export async function checkStorage(storage: Storage, timeoutMs = 3000): Promise<void> {
  await withTimeout(storage.client.send(new HeadBucketCommand({ Bucket: storage.bucket })), timeoutMs, 's3 HeadBucket');
}
