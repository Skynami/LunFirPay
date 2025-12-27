/**
 * 回调代理服务器
 * 监听端口：6666
 * 请求格式：POST https://proxy.domain.com/https://merchant.com/notify
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 6666;

const server = http.createServer(async (req, res) => {
  // 提取原始 URL（移除开头的斜杠）
  const originalUrl = req.url.startsWith('/') ? req.url.slice(1) : req.url;
  
  if (!originalUrl.startsWith('http://') && !originalUrl.startsWith('https://')) {
    res.writeHead(400);
    res.end('Invalid URL');
    return;
  }
  
  try {
    const url = new URL(originalUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    // 复制请求头，移除不需要的头
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-host'];
    headers['host'] = url.host;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: headers,
      rejectUnauthorized: false
    };
    
    const proxyReq = lib.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Proxy Error');
    });
    
    req.pipe(proxyReq);
    
  } catch (e) {
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT);
