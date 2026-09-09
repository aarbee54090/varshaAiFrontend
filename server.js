// Minimal static file server for the frontend, on its own port, separate
// from the backend API. Run this and the backend as two separate
// processes: `npm run dev` in each folder.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5173;

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`Frontend running on http://localhost:${PORT}`);
});
