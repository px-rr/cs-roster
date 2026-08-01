// ============================================================
// Vercel Serverless Function: /api
// Mirrors the old Google Apps Script POST contract:
//   POST { action, token?, ...params } -> JSON
//   GET  -> health check
// ============================================================
'use strict';

const core = require('../lib/core');

module.exports = async (req, res) => {
  // Health check
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, service: 'CS Roster API', time: new Date().toISOString() }));
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 405;
    res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    return;
  }

  let body = '';
  try {
    for await (const chunk of req) body += chunk;
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode(500);
    res.end(JSON.stringify({ success: false, error: 'Failed to read body' }));
    return;
  }

  let params;
  try { params = JSON.parse(body || '{}'); }
  catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    return;
  }

  try {
    await core.connect();
    const result = await core.routeAction(params.action || '', params);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[api error]', err);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 500;
    res.end(JSON.stringify({ success: false, error: String(err && err.message || err) }));
  }
};
