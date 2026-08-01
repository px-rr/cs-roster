// ============================================================
// Vercel Serverless Function: GET /photos/:name
// Serves employee photos stored in the shared DB.
// ============================================================
const core = require('../lib/core');

module.exports = async (req, res) => {
  const name = (req.query && req.query.name) || req.url.replace('/photos/', '').split('/').pop();
  const match = /^emp_(\d+)\.jpg$/.exec(name);
  if (!match) {
    res.statusCode = 400; res.end('Invalid photo name'); return;
  }

  try {
    await core.connect();
    const photo = await core.readPhoto(match[1]);
    if (!photo) { res.statusCode = 404; res.end('Not found'); return; }
    const buf = Buffer.from(photo.data, 'base64');
    res.setHeader('Content-Type', photo.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buf);
  } catch (e) { res.statusCode = 500; res.end('Error'); }
};
