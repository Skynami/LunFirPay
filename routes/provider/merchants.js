/**
 * Provider 商户管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const {
  generateRandomMixedCaseAlnum,
  generateRandomUsername,
  generateRsaKeyPair,
  generateUniquePid
} = require('../../utils/helpers');
const { requireProviderRamPermission } = require('../auth');

// 支付类型配置
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', status: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', status: 1 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', status: 1 },
  { id: 4, name: 'bank', showname: '网银支付', status: 1 },
  { id: 5, name: 'jdpay', showname: '京东支付', status: 1 },
  { id: 6, name: 'paypal', showname: 'PayPal', status: 1 },
  { id: 7, name: 'ecny', showname: '数字人民币', status: 1 }
];

function getAllPayTypes() {
  return payTypes.filter(pt => pt.status === 1);
}

async function generateUniqueUsername() {
  while (true) {
    const candidate = generateRandomUsername(12);
    const [existing] = await db.query('SELECT id FROM users WHERE username = ? LIMIT 1', [candidate]);
    if (existing.length === 0) return candidate;
  }
}

// 获取商户列表（需要 merchant 权限）
router.get('/merchants', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, merchantId, name, status } = req.query;

    // 单服务商模式：merchants 表直接存储商户信息，排除管理员用户
    let sql = `SELECT m.id, m.pid, m.user_id, m.fee_rate, m.fee_rates, m.fee_payer, m.status, m.pay_group_id,
               m.created_at, m.approved_at as joined_at,
               COALESCE(m.name, u.username) as name, m.remark, m.balance,
               u.username
               FROM merchants m
               JOIN users u ON m.user_id = u.id
           WHERE m.status IN ('pending', 'active', 'paused', 'disabled', 'banned')
             AND u.is_admin = 0`;
    const params = [];
    if (status) {
      sql += ' AND m.status = ?';
      params.push(status);
    }

    if (merchantId) {
      // 支持按顺序ID搜索（m.id 或 m.user_id）
      sql += ' AND (m.id = ? OR m.user_id = ?)';
      params.push(parseInt(merchantId), parseInt(merchantId));
    }

    if (name) {
      sql += ' AND (m.name LIKE ? OR u.username LIKE ?)';
      params.push(`%${name}%`, `%${name}%`);
    }

    // 统计总数
    const [countResult] = await db.query(
      sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM'),
      params
    );
    const total = countResult[0]?.total || 0;

    sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));

    const [merchants] = await db.query(sql, params);

    // 获取默认支付组
    const [defaultGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    const defaultGroup = defaultGroups.length > 0 ? defaultGroups[0] : null;
    const allPayTypes = getAllPayTypes();

    // 获取每个商户的交易统计和费率
    const list = await Promise.all(merchants.map(async (merchant) => {
      // 今日统计（orders.merchant_id 存的是 users.id）
      const [[dayStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = CURDATE()`,
        [merchant.user_id]
      );
      // 昨日统计
      const [[yesterdayStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
        [merchant.user_id]
      );
      // 本周统计
      const [[weekStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
        [merchant.user_id]
      );

      // 获取商户的支付组费率
      let payGroup = null;
      if (merchant.pay_group_id) {
        const [groups] = await db.query(
          'SELECT * FROM provider_pay_groups WHERE id = ?',
          [merchant.pay_group_id]
        );
        if (groups.length > 0) payGroup = groups[0];
      }
      // 如果没有指定支付组，使用默认组
      if (!payGroup) payGroup = defaultGroup;

      // 解析支付组配置，计算每个支付类型的费率
      let rates = {};
      if (payGroup && payGroup.config) {
        try {
          const config = typeof payGroup.config === 'string' 
            ? JSON.parse(payGroup.config) 
            : payGroup.config;
          
          for (const [payTypeId, typeConfig] of Object.entries(config)) {
            const pt = allPayTypes.find(p => p.id === parseInt(payTypeId));
            if (pt && typeConfig.rate !== undefined && typeConfig.rate !== null) {
              rates[pt.name] = {
                name: pt.showname,
                rate: typeConfig.rate / 100
              };
            }
          }
        } catch (e) {
          console.error('解析支付组配置错误:', e);
        }
      }

      // 解析商户独立费率 JSON
      let merchantFeeRates = null;
      if (merchant.fee_rates) {
        try {
          merchantFeeRates = typeof merchant.fee_rates === 'string' 
            ? JSON.parse(merchant.fee_rates) 
            : merchant.fee_rates;
        } catch (e) {
          console.error('解析商户费率JSON错误:', e);
        }
      }

      return {
        ...merchant,
        fee_rates: merchantFeeRates,
        day_money: dayStats?.money || 0,
        yesterday_money: yesterdayStats?.money || 0,
        week_money: weekStats?.money || 0,
        pay_group_name: payGroup?.name || null,
        rates // 支付组默认费率
      };
    }));

    res.json({ code: 0, data: { list, total } });
  } catch (error) {
    console.error('获取商户列表错误:', error);
    res.json({ code: -1, msg: '获取商户列表失败' });
  }
});

// 创建商户账号（随机 12位用户名 + 32位密码），默认未开通
router.post('/merchants/create-user', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { email } = req.body;
    
    // 邮箱必填
    if (!email) {
      return res.json({ code: -1, msg: '请填写邮箱' });
    }
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ code: -1, msg: '邮箱格式不正确' });
    }
    
    // 检查邮箱是否已存在
    const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existingEmail.length > 0) {
      return res.json({ code: -1, msg: '邮箱已被注册' });
    }
    
    const username = await generateUniqueUsername();
    const password = generateRandomMixedCaseAlnum(32);

    // 插入用户（使用自增id）
    const [insertResult] = await db.query(
      'INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, 0)',
      [username, password, email]
    );
    const userId = insertResult.insertId;

    // 创建商户记录（user_id 引用 users.id），管理员创建的商户直接激活并生成 pid/key
    const pid = await generateUniquePid();
    const apiKey = generateRandomMixedCaseAlnum(32);
    const rsaKeyPair = generateRsaKeyPair();
    
    // 获取默认支付组ID
    const [defaultPayGroups] = await db.query(
      'SELECT id FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    const defaultPayGroupId = defaultPayGroups.length > 0 ? defaultPayGroups[0].id : null;
    
    await db.query(
      'INSERT INTO merchants (user_id, pid, api_key, rsa_public_key, rsa_private_key, status, approved_at, pay_group_id) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)',
      [userId, pid, apiKey, rsaKeyPair.publicKey, rsaKeyPair.privateKey, 'active', defaultPayGroupId]
    );

    res.json({ code: 0, msg: '创建成功', data: { userId, username, password, email, pid, apiKey } });
  } catch (error) {
    console.error('创建商户账号错误:', error);
    res.json({ code: -1, msg: '创建失败: ' + error.message });
  }
});

// 重置商户登录密码（32位大小写数字混合）
router.post('/merchants/reset-password', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    const newPassword = generateRandomMixedCaseAlnum(32);
    const [result] = await db.query(
      'UPDATE users SET password = ? WHERE id = ? AND is_admin = 0',
      [newPassword, merchantId]
    );
    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    res.json({ code: 0, msg: '重置成功', data: { password: newPassword } });
  } catch (error) {
    console.error('重置商户密码错误:', error);
    res.json({ code: -1, msg: '重置失败: ' + error.message });
  }
});

// 开通商户：生成 PID(12位数字) + KEY(32位大小写数字混合) + RSA密钥
router.post('/merchants/activate', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;

    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    // 单服务商模式，不按 provider_id 过滤
    const [rows] = await db.query(
      'SELECT * FROM merchants WHERE user_id = ? LIMIT 1',
      [merchantId]
    );
    if (rows.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    const record = rows[0];
    if (record.status === 'active' || record.status === 'approved') {
      return res.json({ code: 0, msg: '商户已开通' });
    }

    // 生成12位随机 PID（API使用）
    const pid = await generateUniquePid();
    const apiKey = generateRandomMixedCaseAlnum(32);
    const rsaKeyPair = generateRsaKeyPair();

    await db.query(
      `UPDATE merchants
       SET status = 'active', approved_at = NOW(), pid = ?, api_key = ?, rsa_public_key = ?, rsa_private_key = ?
       WHERE user_id = ?`,
      [pid, apiKey, rsaKeyPair.publicKey, rsaKeyPair.privateKey, merchantId]
    );

    res.json({
      code: 0,
      msg: '已开通',
      data: {
        pid,  // API 使用的12位随机ID
        apiKey
      }
    });
  } catch (error) {
    console.error('开通商户错误:', error);
    res.json({ code: -1, msg: '开通失败：' + error.message });
  }
});

// 暂停商户（不允许删除）
router.post('/merchants/pause', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) return res.json({ code: -1, msg: '缺少商户ID' });

    // 单服务商模式，不按 provider_id 过滤
    await db.query(
      'UPDATE merchants SET status = ? WHERE user_id = ?',
      ['paused', merchantId]
    );
    res.json({ code: 0, msg: '已暂停' });
  } catch (error) {
    console.error('暂停商户错误:', error);
    res.json({ code: -1, msg: '暂停失败: ' + error.message });
  }
});

// 恢复商户（暂停 -> 正常；若未生成PID/KEY则提示先开通）
router.post('/merchants/restore', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) return res.json({ code: -1, msg: '缺少商户ID' });

    // 单服务商模式，不按 provider_id 过滤
    const [rows] = await db.query(
      'SELECT pid, api_key FROM merchants WHERE user_id = ? LIMIT 1',
      [merchantId]
    );
    if (rows.length === 0) return res.json({ code: -1, msg: '商户不存在' });

    if (!rows[0].pid || !rows[0].api_key) {
      return res.json({ code: -1, msg: '商户未开通，请先开通后再恢复' });
    }

    await db.query(
      'UPDATE merchants SET status = ? WHERE user_id = ?',
      ['active', merchantId]
    );
    res.json({ code: 0, msg: '已恢复' });
  } catch (error) {
    console.error('恢复商户错误:', error);
    res.json({ code: -1, msg: '恢复失败: ' + error.message });
  }
});

// 获取商户详情统计（需要 merchant 权限）
router.get('/merchants/stats', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.query;

    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    // 月统计（单服务商模式，不按 provider_id 过滤）
    const [[monthStats]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee 
       FROM orders WHERE merchant_id = ? AND status = 1 
       AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`,
      [merchantId]
    );
    
    // 累计统计
    const [[totalStats]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee 
       FROM orders WHERE merchant_id = ? AND status = 1`,
      [merchantId]
    );

    res.json({
      code: 0,
      data: {
        month_money: monthStats?.money || 0,
        month_fee: monthStats?.fee || 0,
        total_money: totalStats?.money || 0,
        total_fee: totalStats?.fee || 0
      }
    });
  } catch (error) {
    console.error('获取商户统计错误:', error);
    res.json({ code: -1, msg: '获取统计失败' });
  }
});

// 更新商户信息（需要 merchant 权限）
// 注意：修改费率和支付组需要额外的 channel 权限
router.post('/merchants/update', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const ramUser = req.ramUser;
    const { merchant_id, remark, fee_rate, fee_rates, fee_payer, status, pay_group_id } = req.body;

    // 检查是否有 channel 权限（用于修改费率和支付组）
    const hasChannelPermission = !ramUser || 
      (ramUser.permissions && (ramUser.permissions.includes('admin') || ramUser.permissions.includes('channel')));

    const updates = [];
    const params = [];

    // 备注可以直接修改
    if (remark !== undefined) {
      updates.push('remark = ?');
      params.push(remark || null);
    }

    // 费率和支付组需要 channel 权限
    if (fee_rate !== undefined && hasChannelPermission) {
      updates.push('fee_rate = ?');
      params.push(fee_rate);
    }
    // 支持每通道独立费率 (JSON)
    if (fee_rates !== undefined && hasChannelPermission) {
      updates.push('fee_rates = ?');
      params.push(fee_rates ? JSON.stringify(fee_rates) : null);
    }
    if (fee_payer !== undefined && hasChannelPermission) {
      updates.push('fee_payer = ?');
      params.push(fee_payer);
    }
    if (pay_group_id !== undefined && hasChannelPermission) {
      updates.push('pay_group_id = ?');
      params.push(pay_group_id);
    }
    
    // 状态修改只需要 merchant 权限
    if (status !== undefined) {
      // 新状态：inactive/active/paused（兼容 approved/disabled）
      const allowed = new Set(['inactive', 'active', 'paused', 'approved', 'disabled']);
      if (!allowed.has(status)) {
        return res.json({ code: -1, msg: '无效的状态' });
      }
      updates.push('status = ?');
      params.push(status);
    }

    if (updates.length === 0) {
      return res.json({ code: -1, msg: '无更新内容' });
    }

    // 单服务商模式，不按 provider_id 过滤
    // merchant_id 可能是 users.id (user_id) 或 merchants.id
    params.push(merchant_id);

    await db.query(
      `UPDATE merchants SET ${updates.join(', ')} WHERE user_id = ?`,
      params
    );

    res.json({ code: 0, msg: '更新成功' });
  } catch (error) {
    console.error('更新商户错误:', error);
    res.json({ code: -1, msg: '更新失败' });
  }
});

module.exports = router;
