import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

// Build S3 client — supports both real AWS and local MinIO/LocalStack
const s3Client = new S3Client({
  region: config.s3.region,
  credentials: config.s3.accessKeyId
    ? {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      }
    : undefined, // Falls back to instance profile / env in production
  ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
});

/**
 * Uploads an audio file to S3.
 * Uses multipart upload under the hood (via @aws-sdk/lib-storage)
 * so even 500MB files don't blow up memory.
 *
 * @returns {string} S3 key for the uploaded object
 */
export async function uploadAudioToS3(localFilePath, originalFilename, mimeType) {
  const ext = path.extname(originalFilename) || '.audio';
  const s3Key = `audio/${uuidv4()}${ext}`;

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.s3.bucket,
      Key: s3Key,
      Body: createReadStream(localFilePath),
      ContentType: mimeType,
      Metadata: {
        originalFilename: encodeURIComponent(originalFilename),
      },
    },
    // 5MB part size — balances memory use vs. number of API calls
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  });

  await upload.done();
  return s3Key;
}

/**
 * Downloads an S3 object to a local temp path.
 * Returns the local file path.
 */
export async function downloadFromS3(s3Key, destPath) {
  const { createWriteStream } = await import('fs');
  const { pipeline } = await import('stream/promises');

  const command = new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key });
  const response = await s3Client.send(command);

  await pipeline(response.Body, createWriteStream(destPath));
  return destPath;
}

/**
 * Generates a pre-signed URL so clients can download the original audio
 * directly from S3 without going through our server.
 * URL expires in 1 hour by default.
 */
export async function getPresignedDownloadUrl(s3Key, expiresInSeconds = 3600) {
  const command = new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Deletes an object from S3 — called when a job is cancelled or deleted.
 */
export async function deleteFromS3(s3Key) {
  await s3Client.send(
    new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: s3Key })
  );
}

/**
 * Checks whether an object exists in S3 without downloading it.
 */
export async function objectExistsInS3(s3Key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: s3Key }));
    return true;
  } catch {
    return false;
  }
}
