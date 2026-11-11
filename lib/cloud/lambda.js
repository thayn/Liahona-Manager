// AWS Lambda entry point (behind API Gateway HTTP API, under CloudFront /api/*).
// Environment (set by infra/): DATA_BUCKET, MEDIA_BUCKET, USER_POOL_ID,
// USER_POOL_CLIENT_ID, AUTH_DOMAIN, AWS_REGION, LIAHONA_SAMPLES.

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import { makeCloudHandler } from './handler.js';
import { cognitoUsers } from './users.js';

const region = process.env.AWS_REGION;
const s3 = new S3Client({ region });
const DATA_KEY = 'workspace.json';

/** The workspace document in S3, saved only if nobody else saved since we read it. */
export function s3Storage(client, bucket, key = DATA_KEY) {
  return {
    async load() {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { doc: JSON.parse(await r.Body.transformToString()), etag: r.ETag };
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return { doc: null, etag: null };
        throw e;
      }
    },
    async save(doc, etag) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: JSON.stringify(doc), ContentType: 'application/json',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' })
        }));
      } catch (e) {
        const code = e.$metadata?.httpStatusCode;
        if (code === 412 || code === 409 || e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict') {
          const c = new Error('conflict'); c.conflict = true; throw c;
        }
        throw e;
      }
    }
  };
}

const storage = s3Storage(s3, process.env.DATA_BUCKET);

const mediaKey = (folder, name) => `media/${folder}/${name}`;
const media = {
  presignGet: (folder, name) => getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.MEDIA_BUCKET, Key: mediaKey(folder, name) }), { expiresIn: 6 * 3600 }),
  presignPut: (folder, name, type) => getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.MEDIA_BUCKET, Key: mediaKey(folder, name), ...(type ? { ContentType: type } : {}) }), { expiresIn: 3600 }),
  remove: (folder, name) => s3.send(new DeleteObjectCommand({ Bucket: process.env.MEDIA_BUCKET, Key: mediaKey(folder, name) }))
};

const handle = makeCloudHandler({
  storage,
  media,
  auth: { region, userPoolId: process.env.USER_POOL_ID, clientId: process.env.USER_POOL_CLIENT_ID, domain: process.env.AUTH_DOMAIN },
  users: cognitoUsers({ client: new cognito.CognitoIdentityProviderClient({ region }), cmd: cognito, userPoolId: process.env.USER_POOL_ID })
});

/** API Gateway HTTP API (payload 2.0) -> shared handler -> response */
export async function handler(event) {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  let body = {};
  if (event.body) {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try { body = JSON.parse(text); }
    catch { return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"error":"Body is not valid JSON"}' }; }
  }
  const out = await handle({
    method: event.requestContext?.http?.method || 'GET',
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString || ''),
    headers,
    body,
    ip: event.requestContext?.http?.sourceIp || ''
  });
  return { statusCode: out.status, headers: { 'cache-control': 'no-store', ...out.headers }, body: typeof out.body === 'string' ? out.body : String(out.body ?? '') };
}
