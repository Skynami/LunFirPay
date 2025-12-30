const crypto = require('crypto');
const db = require('../config/database');

// 生成随机字符串
function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function randomFromCharset(length, charset) {
  if (!length || length <= 0) return '';
  if (!charset || charset.length < 2) {
    throw new Error('charset must contain at least 2 characters');
  }

  // Rejection sampling to avoid modulo bias
  const maxValidByte = Math.floor(256 / charset.length) * charset.length - 1;
  let out = '';

  while (out.length < length) {
    const buf = crypto.randomBytes(Math.max(16, length));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b > maxValidByte) continue;
      out += charset[b % charset.length];
    }
  }
  return out;
}

function generateRandomDigits(length) {
  return randomFromCharset(length, '0123456789');
}

function generateRandomUsername(length = 12) {
  // 用户名用小写字母+数字，避免大小写混淆
  return randomFromCharset(length, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

function generateRandomMixedCaseAlnum(length = 32) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  // 尽量保证“大小写+数字混合”
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomFromCharset(length, charset);
    if (/[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate)) {
      return candidate;
    }
  }

  // 极小概率未命中，兜底返回
  return randomFromCharset(length, charset);
}

// 生成交易号
function generateTradeNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return dateStr + random;
}

// 生成加入码
function generateJoinCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// MD5签名
function md5Sign(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// 验证签名
function verifySign(params, key, sign) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const expectedSign = md5Sign(sortedParams + key);
  return expectedSign === sign;
}

// 生成签名
function createSign(params, key) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return md5Sign(sortedParams + key);
}

// 获取客户端IP
function getClientIp(req) {
  return req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    '';
}

/**
 * 生成 RSA 密钥对
 * @returns {{publicKey: string, privateKey: string}} Base64 格式的密钥对（与 PHP 兼容）
 */
function generateRsaKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // 转换为纯 Base64 格式（与 PHP 兼容）
  return {
    publicKey: pemToBase64(publicKey),
    privateKey: pemToBase64(privateKey)
  };
}

/**
 * 将 PEM 格式转换为纯 Base64 字符串
 */
function pemToBase64(pem) {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s/g, '');
}

/**
 * 将 Base64 字符串转换为 PEM 格式
 */
function base64ToPem(base64, type = 'PUBLIC KEY') {
  if (!base64 || base64.includes('-----BEGIN')) return base64;
  const formatted = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${formatted}\n-----END ${type}-----`;
}

/**
 * 生成12位不重复的PID（API使用）
 */
async function generateUniquePid() {
  let pid;
  let exists = true;
  while (exists) {
    pid = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const [rows] = await db.query('SELECT id FROM merchants WHERE pid = ?', [pid]);
    exists = rows.length > 0;
  }
  return pid;
}

module.exports = {
  generateRandomString,
  generateRandomDigits,
  generateRandomUsername,
  generateRandomMixedCaseAlnum,
  generateTradeNo,
  generateJoinCode,
  md5Sign,
  verifySign,
  createSign,
  getClientIp,
  generateRsaKeyPair,
  pemToBase64,
  base64ToPem,
  generateUniquePid
};
