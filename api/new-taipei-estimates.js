const NEW_TAIPEI_ESTIMATE_URL =
  'https://data.ntpc.gov.tw/api/datasets/07f7ccb3-ed00-43c4-966d-08e9dab24e95/json';

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, OPTIONS');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const routeId = String(request.query?.routeid || '').trim();
  if (!/^\d+$/.test(routeId)) {
    response.status(400).json({ error: 'routeid must be numeric' });
    return;
  }

  const upstreamUrl = `${NEW_TAIPEI_ESTIMATE_URL}?routeid=${encodeURIComponent(routeId)}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      response.status(upstreamResponse.status).json({
        error: 'New Taipei ETA source request failed',
      });
      return;
    }

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      response.status(502).json({ error: 'Unexpected New Taipei ETA payload' });
      return;
    }

    response.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    response.status(200).json(parsed);
  } catch {
    response.status(502).json({
      error: 'New Taipei ETA source unavailable',
    });
  }
};
