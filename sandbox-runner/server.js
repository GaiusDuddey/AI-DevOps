const express = require('express');
const { exec } = require('child_process');
const app = express();
app.use(express.json());

app.post('/run-test', (req, res) => {
  const { fileName, fileContent } = req.body;
  const fs = require('fs');
  const path = require('path');
  const sandboxPath = path.join(__dirname, '..', 'sandbox', fileName);

  fs.writeFileSync(sandboxPath, fileContent, 'utf-8');

  const cmd = `docker run --rm -v "${path.join(__dirname, '..', 'sandbox').replace(/\\/g, '/')}:/app" -w /app python:3.11-slim sh -c "pip install pytest -q && pytest ${fileName}"`;

  exec(cmd, (error, stdout, stderr) => {
    res.json({
      exitCode: error ? (error.code || 1) : 0,
      stdout,
      stderr
    });
  });
});

app.listen(3939, () => console.log('Sandbox runner listening on port 3939'));