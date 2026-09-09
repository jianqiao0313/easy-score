import assert from 'node:assert/strict';
import test from 'node:test';
import { publishDockerHubReadme } from '../scripts/publish-dockerhub-readme.mjs';

const input = { username: 'test-owner', token: 'test-secret', readme: '# easy-score\n\n钢琴 `1.0.4`\n' };
const jsonResponse = (data, status = 200) => Response.json(data, { status });

test('Docker Hub publishing sends the exact README and verifies the public result', async () => {
  const requests = [];
  await publishDockerHubReadme(input, async (url, options) => {
    requests.push({ url, ...options });
    if (requests.length === 1) return jsonResponse({ access_token: 'test-access-token' });
    return jsonResponse({ full_description: input.readme });
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'https://hub.docker.com/v2/auth/token');
  assert.deepEqual(JSON.parse(requests[0].body), { identifier: input.username, secret: input.token });
  assert.equal(requests[1].url, 'https://hub.docker.com/v2/repositories/test-owner/easy-score/');
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].headers.authorization, 'Bearer test-access-token');
  assert.deepEqual(JSON.parse(requests[1].body), { full_description: input.readme });
  assert.equal(requests[2].url, requests[1].url);
  assert.equal(requests[2].headers, undefined, 'public readback must not send credentials');
  assert.ok(requests.every((request) => request.redirect === 'error'));
});

test('Docker Hub authentication failure stops before any metadata write without echoing secrets', async () => {
  let calls = 0;
  await assert.rejects(publishDockerHubReadme(input, async () => {
    calls += 1;
    return jsonResponse({ detail: input.token }, 401);
  }), { message: 'Docker Hub authentication failed: HTTP 401' });
  assert.equal(calls, 1);
});

test('Docker Hub publishing rejects a stale public README after the update', async () => {
  let calls = 0;
  await assert.rejects(publishDockerHubReadme(input, async () => {
    calls += 1;
    return jsonResponse(calls === 1 ? { access_token: 'test-access-token' } : { full_description: 'old README' });
  }), /README verification failed/);
});
