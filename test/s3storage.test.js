// The S3 workspace store with the real AWS SDK against a tiny fake S3 that
// honours If-Match / If-None-Match like the real one (412 on a clash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The AWS packages are only installed for the cloud build (npm install), not on the camp laptop.
process.env.AWS_REGION ||= 'us-west-2';
let S3Client, s3Storage;
try {
  ({ S3Client } = await import('@aws-sdk/client-s3'));
  ({ s3Storage } = await import('../lib/cloud/lambda.js'));
} catch { /* skipped below */ }

function fakeS3() {
  const objects = new Map();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const obj = objects.get(key);
    if (req.method === 'GET') {
      if (!obj) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code><Message>none</Message></Error>'); }
      res.writeHead(200, { ETag: obj.etag, 'Content-Type': 'application/json' }); return res.end(obj.body);
    }
    if (req.method === 'PUT') {
      const im = req.headers['if-match'], inm = req.headers['if-none-match'];
      if ((im && (!obj || obj.etag !== im)) || (inm === '*' && obj)) {
        res.writeHead(412, { 'Content-Type': 'application/xml' });
        return res.end('<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>');
      }
      const etag = `"e${++n}"`;
      objects.set(key, { body: Buffer.concat(chunks), etag });
      res.writeHead(200, { ETag: etag }); return res.end();
    }
    res.writeHead(405); res.end();
  });
  return new Promise(r => server.listen(0, () => r({ server, port: server.address().port })));
}

test('S3 store: first save, conditional saves, clash detected', { skip: !S3Client && 'AWS packages not installed' }, async () => {
  const { server, port } = await fakeS3();
  try {
    const client = new S3Client({ region: 'us-west-2', endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    const st = s3Storage(client, 'data');
    const empty = await st.load();
    assert.equal(empty.doc, null);
    await st.save({ v: 1 }, null);
    await assert.rejects(st.save({ v: 'other' }, null), e => e.conflict, 'second "first save" clashes');
    const a = await st.load();
    const b = await st.load();
    assert.deepEqual(a.doc, { v: 1 });
    await st.save({ v: 2 }, a.etag);
    await assert.rejects(st.save({ v: 3 }, b.etag), e => e.conflict, 'stale copy is refused');
    assert.deepEqual((await st.load()).doc, { v: 2 });
  } finally { server.close(); }
});
