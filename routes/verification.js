/**
 * 验证码路由
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const emailService = require('../utils/emailService');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Verification] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

/**
 * 生成10位随机验证码（大小写字母+数字）
 */
function generateVerificationCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * 检查 Turnstile 是否启用
 */
function isTurnstileEnabled() {
  return config.turnstile?.enabled && config.turnstile?.siteKey && config.turnstile?.secretKey;
}

/**
 * 验证 Cloudflare Turnstile token
 */
async function verifyTurnstile(token, ip) {
  // 如果未启用 Turnstile，直接跳过验证
  if (!isTurnstileEnabled()) {
    return true;
  }
  
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        secret: config.turnstile.secretKey,
        response: token,
        remoteip: ip
      })
    });
    
    const result = await response.json();
    return result.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

/**
 * 发送验证码
 * POST /api/verification/send
 * Body: { email, type: 'register'|'reset', turnstileToken }
 */
router.post('/send', async (req, res) => {
  try {
    const { email, type, turnstileToken } = req.body;

    // 检查邮件功能是否启用
    if (!emailService.isEnabled()) {
      return res.json({ code: -1, msg: '邮件功能未启用' });
    }

    // 验证参数
    if (!email || !type) {
      return res.json({ code: -1, msg: '参数不完整' });
    }

    if (!['register', 'reset'].includes(type)) {
      return res.json({ code: -1, msg: '无效的验证码类型' });
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ code: -1, msg: '邮箱格式不正确' });
    }

    // 验证 Turnstile（仅当启用时）
    if (isTurnstileEnabled()) {
      if (!turnstileToken) {
        return res.json({ code: -1, msg: '请完成人机验证' });
      }

      const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const turnstileValid = await verifyTurnstile(turnstileToken, clientIp);
      if (!turnstileValid) {
        return res.json({ code: -1, msg: '人机验证失败，请重试' });
      }
    }

    // 如果是重置密码，检查邮箱是否存在
    if (type === 'reset') {
      const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existingUsers.length === 0) {
        return res.json({ code: -1, msg: '该邮箱未注册' });
      }
    }

    // 如果是注册，检查邮箱是否已被使用
    if (type === 'register') {
      const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existingUsers.length > 0) {
        return res.json({ code: -1, msg: '该邮箱已被注册' });
      }
    }

    // 检查发送频率限制（60秒内只能发送一次）
    const [recentCodes] = await db.query(
      'SELECT id FROM verification_codes WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)',
      [email]
    );
    if (recentCodes.length > 0) {
      return res.json({ code: -1, msg: '发送太频繁，请60秒后再试' });
    }

    // 生成验证码
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10分钟后过期

    // 删除该邮箱之前的验证码
    await db.query('DELETE FROM verification_codes WHERE email = ? AND type = ?', [email, type]);

    // 保存验证码
    await db.query(
      'INSERT INTO verification_codes (email, code, type, expires_at, ip) VALUES (?, ?, ?, ?, ?)',
      [email, code, type, expiresAt, clientIp]
    );

    // 异步发送邮件（不阻塞响应）
    emailService.sendVerificationEmail(email, code, type)
      .then(() => {
        console.log(`[Verification] 验证码已发送到 ${email}`);
      })
      .catch((error) => {
        console.error(`[Verification] 发送验证码失败: ${error.message}`);
      });

    res.json({ code: 0, msg: '验证码已发送，请查收邮件' });
  } catch (error) {
    console.error('发送验证码错误:', error);
    res.json({ code: -1, msg: '发送验证码失败：' + error.message });
  }
});

/**
 * 验证验证码（内部使用）
 * @param {string} email
 * @param {string} code
 * @param {string} type
 * @returns {Promise<boolean>}
 */
async function verifyCode(email, code, type) {
  // 如果邮件功能未启用，跳过验证码验证
  if (!emailService.isEnabled()) {
    return true;
  }

  const [rows] = await db.query(
    'SELECT id FROM verification_codes WHERE email = ? AND code = ? AND type = ? AND expires_at > NOW() AND used = 0',
    [email, code, type]
  );
  
  if (rows.length > 0) {
    // 标记验证码为已使用
    await db.query('UPDATE verification_codes SET used = 1 WHERE email = ? AND code = ? AND type = ?', [email, code, type]);
    return true;
  }
  
  return false;
}

/**
 * 检查邮件功能是否启用
 */
function isEmailEnabled() {
  return emailService.isEnabled();
}

// 导出验证函数供其他模块使用
router.verifyCode = verifyCode;
router.isEmailEnabled = isEmailEnabled;

module.exports = router;
