const express = require('express');
const { rcWebhook } = require('../runtime');

const router = express.Router();

router.post('/webhook/rocketchat', rcWebhook.handler);

module.exports = router;
