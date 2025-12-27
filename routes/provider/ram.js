/**
 * Provider RAM 子账户管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { requireProviderMainAccount } = require('../auth');

// 生成 RAM 用户ID（13位数字，服务商RAM开头 2,4,6,8,0）
function generateProviderRamUserId() {
  const starts = ['2', '4', '6', '8', '0'];
  const firstDigit = starts[Math.floor(Math.random() * starts.length)];
  let rest = '';
  for (let i = 0; i < 12; i++) {
    rest += Math.floor(Math.random() * 10).toString();
  }
  return firstDigit + rest;
}

// 生成随机密码（18位大小写字母数字混合）
function generateRamPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < 18; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// 安全验证函数 - 防止XSS和注入攻击
function sanitizeInput(str, maxLen = 50) {
  if (!str || typeof str !== 'string') return null;
  // 移除HTML标签和危险字符
  const cleaned = str
    .replace(/<[^>]*>/g, '')  // 移除HTML标签
    .replace(/[<>'"`;${}()\\]/g, '')  // 移除危险字符
    .replace(/\.\.\//g, '')  // 移除路径遍历
    .replace(/javascript:/gi, '')  // 移除JS协议
    .replace(/\x00/g, '')  // 移除NULL字节
    .trim();
  // 限制长度
  return cleaned.substring(0, maxLen);
}

// 验证供应商权限数据
function validateProviderPermissions(perms) {
  if (!Array.isArray(perms)) return false;
  const allowedPerms = ['admin', 'order', 'merchant', 'channel', 'settings'];
  return perms.every(p => typeof p === 'string' && allowedPerms.includes(p));
}

// 获取RAM成员列表（仅主账户）
router.get('/ram/members', requireProviderMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;

    const [members] = await db.query(
      `SELECT id, user_id, display_name, permissions, status, last_login_at, last_login_ip, created_at
       FROM user_ram 
       WHERE owner_id = ? AND owner_type = 'admin'
       ORDER BY created_at DESC`,
      [user_id]
    );

    res.json({ code: 0, data: members });
  } catch (error) {
    console.error('获取RAM成员错误:', error);
    res.json({ code: -1, msg: '获取RAM成员失败' });
  }
});

// 添加RAM成员（自动生成用户名和密码）（仅主账户）
router.post('/ram/add', requireProviderMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    let { displayName, permissions } = req.body;

    // 输入验证 - 清理 displayName
    displayName = sanitizeInput(displayName, 30);

    // 验证权限 - 必须选择至少一个权限
    if (!permissions || permissions.length === 0) {
      return res.json({ code: -1, msg: '请至少选择一个权限' });
    }

    // 验证权限值是否合法
    if (!validateProviderPermissions(permissions)) {
      return res.json({ code: -1, msg: '权限值不合法' });
    }

    // 验证权限类型 - admin与所有其他权限互斥
    const otherPermissions = ['order', 'merchant', 'channel', 'settings'];
    const hasAdmin = permissions.includes('admin');
    const hasOther = permissions.some(p => otherPermissions.includes(p));
    
    if (hasAdmin && hasOther) {
      return res.json({ code: -1, msg: '管理员权限与其他权限互斥，不能同时选择' });
    }

    // 生成唯一的 RAM 用户ID
    let ramUserId;
    let isUnique = false;
    while (!isUnique) {
      ramUserId = generateProviderRamUserId();
      const [existing] = await db.query('SELECT id FROM user_ram WHERE user_id = ?', [ramUserId]);
      if (existing.length === 0) {
        isUnique = true;
      }
    }

    // 生成随机密码
    const password = generateRamPassword();

    // 创建 RAM 用户
    await db.query(
      `INSERT INTO user_ram (user_id, owner_id, owner_type, display_name, password, permissions, status)
       VALUES (?, ?, 'admin', ?, ?, ?, 1)`,
      [ramUserId, user_id, displayName || null, password, JSON.stringify(permissions)]
    );

    res.json({ 
      code: 0, 
      msg: '添加成功',
      data: {
        userId: ramUserId,
        password: password
      }
    });
  } catch (error) {
    console.error('添加RAM成员错误:', error);
    res.json({ code: -1, msg: '添加失败: ' + error.message });
  }
});

// 更新RAM成员（仅主账户）
router.post('/ram/update', requireProviderMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    let { id, displayName, permissions, status, resetPassword } = req.body;

    // 清理 displayName 输入
    if (displayName !== undefined) {
      displayName = sanitizeInput(displayName, 30);
    }

    // 验证权限 - 必须选择至少一个权限
    if (permissions && permissions.length === 0) {
      return res.json({ code: -1, msg: '请至少选择一个权限' });
    }

    // 验证权限值是否合法
    if (permissions && !validateProviderPermissions(permissions)) {
      return res.json({ code: -1, msg: '权限值不合法' });
    }

    // 验证权限类型 - admin与所有其他权限互斥
    if (permissions) {
      const otherPermissions = ['order', 'merchant', 'channel', 'settings'];
      const hasAdmin = permissions.includes('admin');
      const hasOther = permissions.some(p => otherPermissions.includes(p));
      
      if (hasAdmin && hasOther) {
        return res.json({ code: -1, msg: '管理员权限与其他权限互斥，不能同时选择' });
      }
    }

    // 检查成员是否存在且属于当前用户
    const [members] = await db.query(
      'SELECT id FROM user_ram WHERE id = ? AND owner_id = ? AND owner_type = "admin"',
      [id, user_id]
    );

    if (members.length === 0) {
      return res.json({ code: -1, msg: '成员不存在' });
    }

    const updates = [];
    const params = [];

    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(displayName);
    }
    if (permissions !== undefined) {
      updates.push('permissions = ?');
      params.push(JSON.stringify(permissions));
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }

    let newPassword = null;
    if (resetPassword) {
      newPassword = generateRamPassword();
      updates.push('password = ?');
      params.push(newPassword);
    }

    if (updates.length > 0) {
      params.push(id);
      await db.query(
        `UPDATE user_ram SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }

    const result = { code: 0, msg: '更新成功' };
    if (newPassword) {
      result.data = { newPassword };
    }
    res.json(result);
  } catch (error) {
    console.error('更新RAM成员错误:', error);
    res.json({ code: -1, msg: '更新失败' });
  }
});

// 删除RAM成员（仅主账户）
router.post('/ram/remove', requireProviderMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id } = req.body;

    // 检查成员是否存在且属于当前用户
    const [members] = await db.query(
      'SELECT user_id FROM user_ram WHERE id = ? AND owner_id = ? AND owner_type = "admin"',
      [id, user_id]
    );

    if (members.length === 0) {
      return res.json({ code: -1, msg: '成员不存在' });
    }

    const ramUserId = members[0].user_id;

    // 删除 RAM 用户的会话
    await db.query('DELETE FROM sessions WHERE user_id = ?', [ramUserId]);

    // 删除 RAM 用户
    await db.query(
      'DELETE FROM user_ram WHERE id = ? AND owner_id = ? AND owner_type = "admin"',
      [id, user_id]
    );

    res.json({ code: 0, msg: '删除成功' });
  } catch (error) {
    console.error('删除RAM成员错误:', error);
    res.json({ code: -1, msg: '删除失败' });
  }
});

module.exports = router;
