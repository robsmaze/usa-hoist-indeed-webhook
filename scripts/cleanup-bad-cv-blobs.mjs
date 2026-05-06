// One-shot sweeper: list every blob under `resumes/linkedin/`, fetch the
// first 8 bytes via Range request, sniff magic bytes, and delete the blob
// if its extension doesn't match the actual file type. Lets the dashboard's
// /api/cv self-heal by re-fetching from LinkupAPI on the next view.
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=$(grep -m1 ^BLOB_READ_WRITE_TOKEN \
//     /Users/robby/Documents/usa-hoist-indeed-webhook/.env.local \
//     | cut -d= -f2- | tr -d '"') \
//   node /tmp/cleanup-bad-cv-blobs.mjs

import { list, del } from '@vercel/blob';

const PREFIX = 'resumes/linkedin/';

function sniff(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const [b0, b1, b2, b3] = buffer;
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return '.pdf';
  if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05) && (b3 === 0x04 || b3 === 0x06)) return '.docx';
  if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return '.doc';
  if (b0 === 0x7B && b1 === 0x5C && b2 === 0x72 && b3 === 0x74) return '.rtf';
  return '.bin';
}

const all = [];
let cursor;
do {
  const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
  all.push(...(page.blobs || []));
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

console.log(`scanned ${all.length} blobs under ${PREFIX}`);

const badUrls = [];
for (const b of all) {
  const ext = (b.pathname.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
  const r = await fetch(b.url, { headers: { Range: 'bytes=0-7' } });
  const ab = await r.arrayBuffer();
  const sniffed = sniff(Buffer.from(ab));
  const ok = sniffed === ext;
  console.log(`  ${ok ? 'OK ' : 'BAD'}  ${b.pathname.padEnd(48)}  ext=${ext.padEnd(5)}  bytes=${sniffed}`);
  if (!ok) badUrls.push(b.url);
}

if (badUrls.length === 0) {
  console.log('\nno bad blobs to delete.');
  process.exit(0);
}

console.log(`\ndeleting ${badUrls.length} mislabeled blobs…`);
await del(badUrls);
console.log('done. Next /api/cv call for each candidate will refetch + rewrite at the correct path.');
