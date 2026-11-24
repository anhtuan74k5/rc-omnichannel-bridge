const express = require('express');
const documents = require('../../knowledge/documents');
const { authorizeAdmin } = require('../auth');

const router = express.Router();

router.post('/documents/upload', (req, res) => {
  const authResult = authorizeAdmin(req);
  if (authResult) return res.status(authResult.status).json({ success: false, error: authResult.message });
  try {
    const result = documents.uploadDocument(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[documents] Upload failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/documents', (req, res) => {
  const authResult = authorizeAdmin(req);
  if (authResult) return res.status(authResult.status).json({ success: false, error: authResult.message });
  try {
    const { platform, platformUserId } = req.query;
    const result = documents.listDocuments(platform, platformUserId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[documents] List failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
