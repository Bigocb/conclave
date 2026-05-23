#!/usr/bin/env node
/**
 * Mock OpenAI-compatible LLM server for testing.
 * Returns structured review JSON for /v1/chat/completions.
 */

import http from 'http';

const PORT = 4242;

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log(`[mock-llm] Received completion request`);

      const review = {
        scores: { correctness: 8, efficiency: 7, security: 6 },
        weighted_overall: 7,
        reviewer_confidence: 0.85,
        comment: 'The implementation is solid overall. Code follows good patterns but could improve on security validation before processing user input. Efficiency is reasonable for the scope.',
        suggestions: [
          'Add input validation before processing',
          'Consider caching frequently accessed data',
          'Add error handling for edge cases',
        ],
        approved: true,
      };

      const content = JSON.stringify(review);
      const response = {
        id: 'chatcmpl-mock-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-gpt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(response));
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`[mock-llm] Listening on http://localhost:${PORT}`);
});