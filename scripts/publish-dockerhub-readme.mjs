import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function publishDockerHubReadme({ username, token, readme }, request = fetch) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(username ?? '') || !token || !readme?.trim() || readme.length > 25_000) {
    throw new Error('Docker Hub credentials or README are missing or invalid');
  }
  const options = { redirect: 'error', signal: AbortSignal.timeout(30_000) };
  const auth = await request('https://hub.docker.com/v2/auth/token', {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, secret: token }),
  });
  if (!auth.ok) throw new Error(`Docker Hub authentication failed: HTTP ${auth.status}`);
  const { access_token: accessToken } = await auth.json();
  if (!accessToken) throw new Error('Docker Hub did not return an access token');

  const repositoryUrl = `https://hub.docker.com/v2/repositories/${username}/easy-score/`;
  const updated = await request(repositoryUrl, {
    ...options,
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ full_description: readme }),
  });
  if (!updated.ok) throw new Error(`Docker Hub README update failed: HTTP ${updated.status}`);

  const published = await request(repositoryUrl, options);
  if (!published.ok || (await published.json()).full_description !== readme) {
    throw new Error('Docker Hub README verification failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publishDockerHubReadme({
      username: process.env.DOCKERHUB_USERNAME,
      token: process.env.DOCKERHUB_TOKEN,
      readme: await readFile(new URL('../docker/README.md', import.meta.url), 'utf8'),
    });
    console.log('Docker Hub README updated and verified');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
