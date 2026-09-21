import { createServer, type Server } from 'node:http';

export type UpdateFixtureServer = {
  url: string;
  setReleases: (releases: unknown) => void;
  close: () => Promise<void>;
};

export async function startUpdateFixtureServer(initialReleases: unknown): Promise<UpdateFixtureServer> {
  let releases = initialReleases;
  const server: Server = createServer((request, response) => {
    if (request.url !== '/releases') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(releases));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('UPDATE_FIXTURE_SERVER_ADDRESS_MISSING');
  return {
    url: `http://127.0.0.1:${address.port}/releases`,
    setReleases: (next) => { releases = next; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
