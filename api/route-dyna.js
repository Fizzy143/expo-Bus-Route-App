const ROUTE_DYNA_URL = 'https://pda5284.gov.taipei/MQS/RouteDyna';

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

  const upstreamUrl = `${ROUTE_DYNA_URL}?routeid=${encodeURIComponent(routeId)}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      response.status(upstreamResponse.status).json({
        error: 'RouteDyna source request failed',
      });
      return;
    }

    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      response.status(502).json({ error: 'Unexpected RouteDyna payload' });
      return;
    }

    response.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    response.status(200).json(parsed);
  } catch {
    response.status(502).json({
      error: 'RouteDyna source unavailable',
    });
  }
};
