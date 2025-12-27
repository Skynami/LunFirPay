const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { generateRandomString } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const telegramService = require('../Telegram');
const emailService = require('../utils/emailService');
const systemConfig = require('../utils/systemConfig');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Auth] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

/**
 * 检查 Turnstile 是否启用
 */
function isTurnstileEnabled() {
  return config.turnstile?.enabled && config.turnstile?.siteKey && config.turnstile?.secretKey;
}

/**
 * 验证 Cloudflare Turnstile token
 * @param {string} token - Turnstile token
 * @param {string} ip - 客户端IP
 * @returns {Promise<boolean>}
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
 * 生成 RAM 用户ID（13位数字）
 * @param {string} ownerType - 'merchant' 或 'admin'
 * @returns {string} 13位数字用户ID
 */
function generateRamUserId(ownerType) {
  // 商户RAM: 开头 1,3,5,7,9
  // 管理员RAM: 开头 2,4,6,8,0
  const merchantStarts = ['1', '3', '5', '7', '9'];
  const adminStarts = ['2', '4', '6', '8', '0'];
  const starts = ownerType === 'merchant' ? merchantStarts : adminStarts;
  const firstDigit = starts[Math.floor(Math.random() * starts.length)];
  
  // 生成后12位随机数字
  let rest = '';
  for (let i = 0; i < 12; i++) {
    rest += Math.floor(Math.random() * 10).toString();
  }
  
  return firstDigit + rest;
}

/**
 * 生成随机密码（18位大小写字母数字混合）
 * @returns {string}
 */
function generateRamPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < 18; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * 检查用户名是否为 RAM 格式（13位纯数字）
 * @param {string} username
 * @returns {boolean}
 */
function isRamUsername(username) {
  return /^\d{13}$/.test(username);
}

// 获取配置信息（前端使用）
router.get('/config', async (req, res) => {
  const siteName = await systemConfig.getSiteName();
  res.json({
    code: 0,
    data: {
      emailEnabled: emailService.isEnabled(),
      siteName: siteName,
      turnstileEnabled: isTurnstileEnabled(),
      turnstileSiteKey: isTurnstileEnabled() ? config.turnstile.siteKey : ''
    }
  });
});

// 注册 - 只支持商户注册（服务商由系统管理员创建）
router.post('/register', async (req, res) => {
  try {
    const { username, password, email, turnstileToken, verificationCode } = req.body;
    
    if (!username || !password || !email) {
      return res.json({ code: -1, msg: '请填写完整信息' });
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

    // 邮箱验证码：仅当系统启用邮件功能时才校验验证码
    if (emailService.isEnabled()) {
      if (!verificationCode) {
        return res.json({ code: -1, msg: '请输入邮箱验证码' });
      }

      const [validCodes] = await db.query(
        'SELECT id FROM verification_codes WHERE email = ? AND code = ? AND type = ? AND expires_at > NOW() AND used = 0',
        [email, verificationCode, 'register']
      );
      if (validCodes.length === 0) {
        return res.json({ code: -1, msg: '验证码无效或已过期' });
      }
    }

    // 检查用户名是否使用了 RAM 格式（13位纯数字）
    if (isRamUsername(username)) {
      return res.json({ code: -1, msg: '用户名不能为13位纯数字格式，该格式保留给RAM账户' });
    }

    // 检查用户名是否存在
    const [existingUser] = await db.query(
      'SELECT id FROM users WHERE username = ?', 
      [username]
    );
    if (existingUser.length > 0) {
      return res.json({ code: -1, msg: '用户名已存在' });
    }

    // 检查邮箱是否存在
    const [existingEmail] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existingEmail.length > 0) {
      return res.json({ code: -1, msg: '邮箱已被注册' });
    }

    // 新流程：注册时不生成 API 密钥（开通后由管理员生成）
    const apiKey = null;

    // 检查是否是首个用户（自动成为管理员）
    const [userCount] = await db.query('SELECT COUNT(*) as count FROM users');
    const isFirstUser = userCount[0].count === 0;
    const isAdmin = isFirstUser ? 1 : 0;
    // 单服务商模式：首个用户为管理员(admin)，其他为商户(merchant)
    const userType = isFirstUser ? 'admin' : 'merchant';

    // 插入用户到 users 表（使用自增 id）
    const [insertResult] = await db.query(
      'INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, ?)',
      [username, password, email, isAdmin]
    );
    const userId = insertResult.insertId; // 获取自增 id

    // 只给非管理员用户创建商户记录
    if (!isFirstUser) {
      // 获取默认支付组ID
      const [defaultPayGroups] = await db.query(
        'SELECT id FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
      );
      const defaultPayGroupId = defaultPayGroups.length > 0 ? defaultPayGroups[0].id : null;
      
      // 创建商户配置（user_id 引用 users.id）
      await db.query(
        'INSERT INTO merchants (user_id, api_key, status, pay_group_id) VALUES (?, ?, ?, ?)',
        [userId, apiKey, 'pending', defaultPayGroupId]
      );
    }

    // 创建会话
    const sessionId = generateRandomString(64);
    await db.query(
      'INSERT INTO sessions (user_id, user_type, session_token) VALUES (?, ?, ?)',
      [userId, userType, sessionId]
    );

    // 标记验证码为已使用（仅在邮件功能启用时）
    if (email && emailService.isEnabled() && verificationCode) {
      await db.query(
        'UPDATE verification_codes SET used = 1 WHERE email = ? AND code = ? AND type = ?',
        [email, verificationCode, 'register']
      );
    }

    // 设置cookie
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1年
      sameSite: 'lax'
    });

    // 通知管理员新用户注册（首个用户不通知）
    if (!isFirstUser) {
      telegramService.notifyAdminNewUser({
        username,
        email,
        user_type: 'merchant'
      });
    }

    // 首个用户提示
    const successMsg = isFirstUser ? '注册成功，您是首个用户，已自动成为管理员' : '注册成功，请等待管理员开通';

    res.json({
      code: 0,
      msg: successMsg,
      data: {
        userId,
        username,
        userType,
        isAdmin: isFirstUser,
        sessionId
      }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.json({ code: -1, msg: '注册失败：' + error.message });
  }
});

// 登录（支持普通用户和RAM用户）
router.post('/login', async (req, res) => {
  try {
    const { username, password, userType } = req.body;

    if (!username || !password) {
      return res.json({ code: -1, msg: '请输入用户名和密码' });
    }

    // 检查是否是 RAM 用户名格式（13位数字）
    if (isRamUsername(username)) {
      // RAM 用户登录
      const [ramUsers] = await db.query(
        'SELECT * FROM user_ram WHERE user_id = ?',
        [username]
      );

      if (ramUsers.length === 0) {
        return res.json({ code: -1, msg: '用户不存在' });
      }

      const ramUser = ramUsers[0];

      if (ramUser.password !== password) {
        return res.json({ code: -1, msg: '密码错误' });
      }

      if (ramUser.status !== 1) {
        return res.json({ code: -1, msg: '账户已被禁用' });
      }

      // 更新最后登录时间和IP
      const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      await db.query(
        'UPDATE user_ram SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
        [clientIp, ramUser.id]
      );

      // 为 RAM 用户创建会话（使用 ram_ 前缀区分）
      const sessionId = 'ram_' + generateRandomString(64);
      
      // 查找或创建会话
      const [existingSessions] = await db.query(
        'SELECT session_token FROM sessions WHERE user_id = ? LIMIT 1',
        [ramUser.user_id]
      );

      let finalSessionId;
      if (existingSessions.length > 0) {
        finalSessionId = existingSessions[0].session_token;
      } else {
        finalSessionId = sessionId;
        await db.query(
          'INSERT INTO sessions (user_id, session_token) VALUES (?, ?)',
          [ramUser.user_id, finalSessionId]
        );
      }

      // 设置cookie
      res.cookie('sessionId', finalSessionId, {
        httpOnly: true,
        maxAge: 365 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      });

      res.json({
        code: 0,
        msg: '登录成功',
        data: {
          userId: ramUser.user_id,
          username: ramUser.user_id,
          displayName: ramUser.display_name,
          isRam: true,
          ownerType: ramUser.owner_type,
          ownerId: ramUser.owner_id,
          permissions: ramUser.permissions,
          sessionId: finalSessionId
        }
      });
      return;
    }

    // 普通用户登录- 从统一为 users 表查询
    const [users] = await db.query(
      'SELECT id, username, password, email, is_admin, status FROM users WHERE username = ?',
      [username]
    );

    if (users.length === 0) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    const user = users[0];

    if (user.password !== password) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    if (user.status !== 1) {
      return res.json({ code: -1, msg: '账户已被禁用' });
    }

    // 根据 is_admin 确定用户类型
    const actualUserType = user.is_admin === 1 ? 'admin' : 'merchant';

    // 如果前端指定为 userType，验证是否匹为 
    if (userType && userType !== 'ram') {
      if (actualUserType !== userType) {
        return res.json({ code: -1, msg: actualUserType === 'admin' ? '请使用管理员登录入口' : '请使用商户登录入口' });
      }
    }

    // 查找现有会话，如果没有则创建新的
    const sessionUserType = actualUserType;
    const [existingSessions] = await db.query(
      'SELECT session_token FROM sessions WHERE user_id = ? AND user_type = ? LIMIT 1',
      [user.id, sessionUserType]
    );

    let sessionId;
    if (existingSessions.length > 0) {
      sessionId = existingSessions[0].session_token;
    } else {
      // 创建新会为 
      sessionId = generateRandomString(64);
      await db.query(
        'INSERT INTO sessions (user_id, user_type, session_token) VALUES (?, ?, ?)',
        [user.id, sessionUserType, sessionId]
      );
    }

    // 设置cookie
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1年
      sameSite: 'lax'
    });

    res.json({
      code: 0,
      msg: '登录成功',
      data: {
        userId: user.id,
        username: user.username,
        email: user.email,
        userType: sessionUserType,
        isAdmin: user.is_admin === 1,
        isRam: false,
        sessionId
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.json({ code: -1, msg: '登录失败：' + error.message });
  }
});

// 验证会话（支持普通用户和RAM用户）
router.get('/verify', async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;

    if (!sessionId) {
      return res.json({ code: -1, msg: '未登录' });
    }

    // 检查是否是 RAM 会话
    if (sessionId.startsWith('ram_')) {
      // RAM 用户验证
      const [sessions] = await db.query(
        'SELECT user_id FROM sessions WHERE session_token = ?',
        [sessionId]
      );

      if (sessions.length === 0) {
        return res.json({ code: -1, msg: '会话无效' });
      }

      const ramUserId = sessions[0].user_id;

      const [ramUsers] = await db.query(
        'SELECT * FROM user_ram WHERE user_id = ?',
        [ramUserId]
      );

      if (ramUsers.length === 0) {
        return res.json({ code: -1, msg: 'RAM用户不存在' });
      }

      const ramUser = ramUsers[0];

      if (ramUser.status !== 1) {
        return res.json({ code: -1, msg: '账户已被禁用' });
      }

      // 获取主账户信息
      const [owners] = await db.query(
        'SELECT username FROM users WHERE id = ?',
        [ramUser.owner_id]
      );

      res.json({
        code: 0,
        msg: '验证成功',
        data: {
          userId: ramUser.user_id,
          username: ramUser.user_id,
          displayName: ramUser.display_name,
          isRam: true,
          ownerType: ramUser.owner_type,
          ownerId: ramUser.owner_id,
          ownerName: owners[0]?.username || '',
          permissions: ramUser.permissions,
          apiKey: null
        }
      });
      return;
    }

    // 普通用户验证 - 从 sessions 表获取 user_type
    const [sessions] = await db.query(
      'SELECT user_id, user_type FROM sessions WHERE session_token = ?',
      [sessionId]
    );

    if (sessions.length === 0) {
      return res.json({ code: -1, msg: '会话无效' });
    }

    const session = sessions[0];

    // 从 users 表查询用户信息
    const [users] = await db.query(
      'SELECT id, username, email, is_admin, status FROM users WHERE id = ?',
      [session.user_id]
    );

    if (users.length === 0) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    const user = users[0];

    if (user.status !== 1) {
      return res.json({ code: -1, msg: '账户已被禁用' });
    }

    // 优先使用 users 表的 is_admin 字段判断用户类型（权威来源）
    // session.user_type 可能为空或旧值，所以用 is_admin 作为备用
    const userType = user.is_admin === 1 ? 'admin' : (session.user_type || 'merchant');

    // 获取 API 密钥（从 users 表）
    const apiKey = user.api_key || null;

    // 获取该用户创建的 RAM 子账户数量
    const [[ramCount]] = await db.query(
      'SELECT COUNT(*) as count FROM user_ram WHERE owner_id = ?',
      [user.id]
    );

    res.json({
      code: 0,
      msg: '验证成功',
      data: {
        userId: user.id,
        username: user.username,
        email: user.email,
        userType: userType,
        isAdmin: user.is_admin === 1,
        isRam: false,
        apiKey,
        ramCount: ramCount.count
      }
    });
  } catch (error) {
    console.error('验证错误:', error);
    res.json({ code: -1, msg: '验证失败：' + error.message });
  }
});

// 退出登录（清除cookie并删除服务端 session）
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;
    
    // 删除数据库中的session
    if (sessionId) {
      await db.query('DELETE FROM sessions WHERE session_token = ?', [sessionId]);
    }
    
    // 清除cookie
    res.clearCookie('sessionId');
    res.json({ code: 0, msg: '退出成功' });
  } catch (error) {
    console.error('退出错误：', error);
    res.json({ code: -1, msg: '退出失败：' + error.message });
  }
});

// 修改密码（支持普通用户和RAM用户）
router.post('/change-password', async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;
    const { oldPassword, newPassword } = req.body;

    if (!sessionId) {
      return res.json({ code: -1, msg: '未登录' });
    }

    const [sessions] = await db.query(
      'SELECT user_id, user_type FROM sessions WHERE session_token = ?',
      [sessionId]
    );

    if (sessions.length === 0) {
      return res.json({ code: -1, msg: '会话无效' });
    }

    const userId = sessions[0].user_id;

    // 检查是否是 RAM 用户（13位数字）
    if (isRamUsername(userId)) {
      // RAM 用户修改密码
      const [ramUsers] = await db.query('SELECT password FROM user_ram WHERE user_id = ?', [userId]);
      if (ramUsers.length === 0) {
        return res.json({ code: -1, msg: 'RAM用户不存在' });
      }
      if (ramUsers[0].password !== oldPassword) {
        return res.json({ code: -1, msg: '旧密码错误' });
      }

      await db.query('UPDATE user_ram SET password = ? WHERE user_id = ?', [newPassword, userId]);
      
      // 删除会话
      await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
      res.clearCookie('sessionId');

      res.json({ code: 0, msg: '密码修改成功，请重新登录' });
      return;
    }

    // 普通用户修改密码
    const [users] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.json({ code: -1, msg: '用户不存在' });
    }
    
    if (users[0].password !== oldPassword) {
      return res.json({ code: -1, msg: '旧密码错误' });
    }

    // 更新密码
    await db.query('UPDATE users SET password = ? WHERE id = ?', [newPassword, userId]);

    // 删除该用户的所有会话（强制重新登录）
    await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);

    // 清除当前cookie
    res.clearCookie('sessionId');

    res.json({ code: 0, msg: '密码修改成功，请重新登录' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.json({ code: -1, msg: '修改密码失败：' + error.message });
  }
});

// 重置密码（通过邮箱验证码）
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword, verificationCode, turnstileToken } = req.body;

    // 如果邮件功能未启用，不允许重置密码
    if (!emailService.isEnabled()) {
      return res.json({ code: -1, msg: '邮件功能未启用，无法重置密码' });
    }

    if (!email || !newPassword || !verificationCode) {
      return res.json({ code: -1, msg: '请填写完整信息' });
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

    // 验证验证码
    const [validCodes] = await db.query(
      'SELECT id FROM verification_codes WHERE email = ? AND code = ? AND type = ? AND expires_at > NOW() AND used = 0',
      [email, verificationCode, 'reset']
    );
    if (validCodes.length === 0) {
      return res.json({ code: -1, msg: '验证码无效或已过期' });
    }

    // 查找用户
    const [users] = await db.query('SELECT id FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      return res.json({ code: -1, msg: '该邮箱未注册' });
    }

    const userId = users[0].id;

    // 更新密码
    await db.query('UPDATE users SET password = ? WHERE email = ?', [newPassword, email]);

    // 标记验证码为已使用 
    await db.query('UPDATE verification_codes SET used = 1 WHERE email = ? AND code = ? AND type = ?', 
      [email, verificationCode, 'reset']);

    // 删除该用户的所有会话（强制重新登录）
    await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);

    res.json({ code: 0, msg: '密码重置成功，请使用新密码登录' });
  } catch (error) {
    console.error('重置密码错误:', error);
    res.json({ code: -1, msg: '重置密码失败：' + error.message });
  }
});

// 导出 RAM 相关函数供其他模块使用
router.generateRamUserId = generateRamUserId;
router.generateRamPassword = generateRamPassword;
router.isRamUsername = isRamUsername;

// ==================== 商户认证中间件 ====================

/**
 * 商户认证中间件 - 使用cookie的sessionId，支持 RAM 用户
 */
const merchantAuthMiddleware = async (req, res, next) => {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) {
    return res.json({ code: -401, msg: '未登录' });
  }

  const [sessions] = await db.query(
    'SELECT s.user_id, s.user_type FROM sessions s WHERE s.session_token = ?',
    [sessionId]
  );

  if (sessions.length === 0) {
    return res.json({ code: -401, msg: '会话无效' });
  }

  const sessionUserId = sessions[0].user_id;
  const sessionUserType = sessions[0].user_type;
  let actualUserId = sessionUserId;
  let ramUser = null;

  // 检查是否是 RAM 用户（13位纯数字）
  if (/^\d{13}$/.test(sessionUserId)) {
    const [ramUsers] = await db.query(
      'SELECT * FROM user_ram WHERE user_id = ? AND owner_type = ?',
      [sessionUserId, 'merchant']
    );
    if (ramUsers.length > 0 && ramUsers[0].status === 1) {
      ramUser = ramUsers[0];
      actualUserId = ramUser.owner_id;  // 使用主账户的 user_id
    } else {
      return res.json({ code: -403, msg: '子账户无权访问商户平台' });
    }
  } else {
    // 普通用户：检查 session 中的 user_type 是否为商户
    if (sessionUserType && sessionUserType !== 'merchant') {
      return res.json({ code: -403, msg: '请登录商户账号访问此平台' });
    }
    
    // 验证用户是否是普通商户（is_admin = 0）
    const [users] = await db.query(
      'SELECT is_admin FROM users WHERE id = ?',
      [actualUserId]
    );
    if (users.length === 0 || users[0].is_admin !== 0) {
      return res.json({ code: -403, msg: '无权访问商户平台' });
    }
  }

  // 获取商户配置（使用实际的主账户 user_id）
  const [merchants] = await db.query(
    'SELECT * FROM merchants WHERE user_id = ?',
    [actualUserId]
  );

  if (merchants.length === 0) {
    return res.json({ code: -403, msg: '商户未配置' });
  }

  req.user = { user_id: actualUserId };
  req.merchant = merchants[0];
  req.ramUser = ramUser;  // RAM 用户信息，普通用户为 null
  next();
};

/**
 * RAM 权限检查中间件工厂
 */
const requireMerchantRamPermission = (...permissions) => {
  return (req, res, next) => {
    // 非 RAM 用户（主账户）拥有所有权限
    if (!req.ramUser) {
      return next();
    }
    
    // permissions 在数据库中存储为 JSON 字符串
    let userPerms = req.ramUser.permissions || [];
    if (typeof userPerms === 'string') {
      try {
        userPerms = JSON.parse(userPerms);
      } catch (e) {
        userPerms = [];
      }
    }
    
    // admin 权限拥有所有权限
    if (userPerms.includes('admin')) {
      return next();
    }
    
    // 检查是否有任一所需权限
    const hasPermission = permissions.some(perm => userPerms.includes(perm));
    if (!hasPermission) {
      return res.json({ code: -403, msg: '无权限执行此操作' });
    }
    
    next();
  };
};

/**
 * 商户主账户专用中间件：只有主账户能访问
 */
const requireMerchantMainAccount = (req, res, next) => {
  if (req.ramUser) {
    return res.json({ code: -403, msg: '子账户无权执行此操作' });
  }
  next();
};

// ============ Provider (管理员) 认证中间件 ============

/**
 * 管理员认证中间件 - 单服务商模式，只需验证管理员身份
 */
const providerAuthMiddleware = async (req, res, next) => {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) {
    return res.json({ code: -401, msg: '未登录' });
  }

  const [sessions] = await db.query(
    'SELECT s.user_id, s.user_type FROM sessions s WHERE s.session_token = ?',
    [sessionId]
  );

  if (sessions.length === 0) {
    return res.json({ code: -401, msg: '会话无效' });
  }

  const sessionUserId = sessions[0].user_id;
  const sessionUserType = sessions[0].user_type;
  let actualUserId = sessionUserId;
  let ramUser = null;

  // 检查是否是 RAM 用户（13位纯数字）
  if (/^\d{13}$/.test(sessionUserId)) {
    const [ramUsers] = await db.query(
      'SELECT * FROM user_ram WHERE user_id = ? AND owner_type = ?',
      [sessionUserId, 'admin']
    );
    if (ramUsers.length > 0 && ramUsers[0].status === 1) {
      ramUser = ramUsers[0];
      actualUserId = ramUser.owner_id;  // 使用主账户的 user_id
    } else {
      return res.json({ code: -403, msg: '子账户无权访问管理后台' });
    }
  } else {
    // 普通用户：检查 session 中的 user_type 是否为管理员
    if (sessionUserType && sessionUserType !== 'admin') {
      return res.json({ code: -403, msg: '请登录管理员账号' });
    }
    
    // 验证用户是否是管理员（is_admin = 1）
    const [users] = await db.query(
      'SELECT is_admin FROM users WHERE id = ?',
      [actualUserId]
    );
    if (users.length === 0 || users[0].is_admin !== 1) {
      return res.json({ code: -403, msg: '无权访问管理后台' });
    }
  }

  req.user = { user_id: actualUserId };
  req.ramUser = ramUser;  // RAM 用户信息，普通用户为 null
  next();
};

/**
 * Provider RAM 权限检查中间件工厂
 * @param {...string} permissions - 所需权限列表（任一满足即可）
 */
const requireProviderRamPermission = (...permissions) => {
  return (req, res, next) => {
    // 非 RAM 用户（主账户）拥有所有权限
    if (!req.ramUser) {
      return next();
    }
    
    // permissions 在数据库中存储为 JSON 字符串
    let userPerms = req.ramUser.permissions || [];
    if (typeof userPerms === 'string') {
      try {
        userPerms = JSON.parse(userPerms);
      } catch (e) {
        userPerms = [];
      }
    }
    
    // admin 权限拥有所有权限
    if (userPerms.includes('admin')) {
      return next();
    }
    
    // 检查是否有任一所需权限
    const hasPermission = permissions.some(perm => userPerms.includes(perm));
    if (!hasPermission) {
      return res.json({ code: -403, msg: '无权限执行此操作' });
    }
    
    next();
  };
};

/**
 * Provider 主账户专用中间件：只有主账户能访问
 */
const requireProviderMainAccount = (req, res, next) => {
  if (req.ramUser) {
    return res.json({ code: -403, msg: '子账户无权管理RAM' });
  }
  next();
};

// 导出路由和中间件
module.exports = router;
// 商户认证中间件
module.exports.merchantAuthMiddleware = merchantAuthMiddleware;
module.exports.requireMerchantRamPermission = requireMerchantRamPermission;
module.exports.requireMerchantMainAccount = requireMerchantMainAccount;
// Provider(管理员)认证中间件
module.exports.providerAuthMiddleware = providerAuthMiddleware;
module.exports.requireProviderRamPermission = requireProviderRamPermission;
module.exports.requireProviderMainAccount = requireProviderMainAccount;
