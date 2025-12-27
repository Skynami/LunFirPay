/**
 * 商户服务管理 & 域名白名单路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { generateRsaKeyPair } = require('../../utils/helpers');

const { requireMerchantMainAccount } = require('../auth');

const isEnabledStatus = (status) => status === 'active' || status === 'approved';

// 支付类型配置（内联）
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', icon: 'alipay.ico', device: 0, status: 1, sort: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', icon: 'wxpay.ico', device: 0, status: 1, sort: 2 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', icon: 'qqpay.ico', device: 0, status: 1, sort: 3 },
  { id: 4, name: 'bank', showname: '银行卡', icon: 'bank.ico', device: 0, status: 1, sort: 4 },
  { id: 5, name: 'usdt', showname: 'USDT', icon: 'usdt.ico', device: 0, status: 1, sort: 5 }
];

function getAllPayTypes(device = null) {
  if (!device) return payTypes.filter(pt => pt.status === 1).sort((a, b) => a.sort - b.sort);
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.filter(pt => pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)).sort((a, b) => a.sort - b.sort);
}

// 获取商户状态信息（单服务商模式）
router.get('/providers', requireMerchantMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;

    // 单服务商模式：只获取商户自己的状态信息
    const [merchants] = await db.query(
      `SELECT pm.*, pm.pid as merchant_pid, pm.fee_rate, pm.fee_payer, pm.pay_group_id
       FROM merchants pm
       WHERE pm.user_id = ?
       ORDER BY pm.created_at DESC`,
      [user_id]
    );

    // 从配置文件获取支付类型列表
    const payTypesList = getAllPayTypes();

    // 为每个记录获取实际费率
    for (const merchant of merchants) {
      if (!isEnabledStatus(merchant.status)) continue;

      // 获取商户的支付组
      let payGroup = null;
      if (merchant.pay_group_id) {
        const [groups] = await db.query(
          'SELECT * FROM provider_pay_groups WHERE id = ?',
          [merchant.pay_group_id]
        );
        if (groups.length > 0) payGroup = groups[0];
      }
      
      // 如果没有指定支付组，使用默认组
      if (!payGroup) {
        const [defaultGroups] = await db.query(
          'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1',
          []
        );
        if (defaultGroups.length > 0) payGroup = defaultGroups[0];
      }

      // 标记是否有通道组
      merchant.has_channel = !!payGroup;

      // 解析支付组配置获取费率
      if (payGroup && payGroup.config) {
        try {
          const config = typeof payGroup.config === 'string' 
            ? JSON.parse(payGroup.config) 
            : payGroup.config;
          
          for (const [payTypeId, typeConfig] of Object.entries(config)) {
            const pt = payTypesList.find(p => p.id === parseInt(payTypeId));
            if (pt && typeConfig.rate !== undefined && typeConfig.rate !== null) {
              // 如果商户有个人费率，优先使用个人费率，否则使用支付组费率
              const finalRate = merchant.fee_rate !== null && merchant.fee_rate !== undefined 
                ? merchant.fee_rate 
                : typeConfig.rate / 100;
              
              if (pt.name === 'alipay') {
                merchant.alipay_fee_rate = finalRate;
              } else if (pt.name === 'wxpay') {
                merchant.wxpay_fee_rate = finalRate;
              }
            }
          }
        } catch (e) {
          console.error('解析支付组配置错误:', e);
        }
      }
    }

    res.json({
      code: 0,
      data: merchants
    });
  } catch (error) {
    console.error('获取商户状态错误:', error);
    res.json({ code: -1, msg: '获取商户状态失败' });
  }
});

// 获取商户详情（含支付组费率和交易统计）单服务商模式
router.get('/provider/detail', async (req, res) => {
  try {
    const { user_id } = req.user;

    // 获取商户信息
    const [merchantInfo] = await db.query(
      `SELECT pm.pay_group_id, pm.fee_rate as merchant_fee_rate
       FROM merchants pm
       WHERE pm.user_id = ? AND pm.status IN ('active', 'approved')
       LIMIT 1`,
      [user_id]
    );

    if (merchantInfo.length === 0) {
      return res.json({ code: -1, msg: '未找到商户信息' });
    }

    // 获取支付组配置（优先使用商户指定的支付组，否则使用默认组）
    let payGroup = null;
    if (merchantInfo[0].pay_group_id) {
      const [groups] = await db.query(
        'SELECT * FROM provider_pay_groups WHERE id = ?',
        [merchantInfo[0].pay_group_id]
      );
      if (groups.length > 0) payGroup = groups[0];
    }
    
    // 如果没有指定支付组或指定的不存在，使用默认组
    if (!payGroup) {
      const [defaultGroups] = await db.query(
        'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1',
        []
      );
      if (defaultGroups.length > 0) payGroup = defaultGroups[0];
    }

    // 从配置文件获取支付方式列表
    const payTypesList = getAllPayTypes();

    // 解析支付组配置，提取费率信息
    let payGroupRates = [];
    const merchantFeeRate = merchantInfo[0].merchant_fee_rate;
    
    if (payGroup && payGroup.config) {
      try {
        const config = typeof payGroup.config === 'string' 
          ? JSON.parse(payGroup.config) 
          : payGroup.config;
        
        for (const [payTypeId, typeConfig] of Object.entries(config)) {
          const pt = payTypesList.find(p => p.id === parseInt(payTypeId));
          if (pt && typeConfig.rate !== undefined && typeConfig.rate !== null) {
            // 如果商户有个人费率，优先使用个人费率，否则使用支付组费率
            const finalRate = merchantFeeRate !== null && merchantFeeRate !== undefined 
              ? merchantFeeRate 
              : typeConfig.rate / 100;
            
            payGroupRates.push({
              pay_type: pt.name,
              pay_type_name: pt.showname,
              fee_rate: finalRate
            });
          }
        }
      } catch (e) {
        console.error('解析支付组配置错误:', e);
      }
    }

    // 获取日交易统计（按渠道）
    const [dayStats] = await db.query(
      `SELECT pay_type, COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders 
       WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = CURDATE()
       GROUP BY pay_type`,
      [user_id]
    );

    // 获取月交易统计（按渠道）
    const [monthStats] = await db.query(
      `SELECT pay_type, COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders 
       WHERE merchant_id = ? AND status = 1 
       AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())
       GROUP BY pay_type`,
      [user_id]
    );

    // 获取年交易统计（按渠道）
    const [yearStats] = await db.query(
      `SELECT pay_type, COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders 
       WHERE merchant_id = ? AND status = 1 AND YEAR(created_at) = YEAR(CURDATE())
       GROUP BY pay_type`,
      [user_id]
    );

    // 获取累计统计（按渠道）
    const [totalStats] = await db.query(
      `SELECT pay_type, COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders 
       WHERE merchant_id = ? AND status = 1
       GROUP BY pay_type`,
      [user_id]
    );

    // 获取总计
    const [[dayTotal]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = CURDATE()`,
      [user_id]
    );
    const [[monthTotal]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders WHERE merchant_id = ? AND status = 1 
       AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`,
      [user_id]
    );
    const [[yearTotal]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders WHERE merchant_id = ? AND status = 1 AND YEAR(created_at) = YEAR(CURDATE())`,
      [user_id]
    );
    const [[allTotal]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee, COUNT(*) as count
       FROM orders WHERE merchant_id = ? AND status = 1`,
      [user_id]
    );

    res.json({
      code: 0,
      data: {
        payGroupRates,
        stats: {
          day: { byChannel: dayStats, total: dayTotal },
          month: { byChannel: monthStats, total: monthTotal },
          year: { byChannel: yearStats, total: yearTotal },
          all: { byChannel: totalStats, total: allTotal }
        }
      }
    });
  } catch (error) {
    console.error('获取服务商详情错误:', error);
    res.json({ code: -1, msg: '获取详情失败' });
  }
});

// 获取PID的V2接口密钥（RSA公钥和私钥）- 单服务商模式
router.get('/provider/v2-keys', async (req, res) => {
  try {
    const { user_id } = req.user;

    // 获取商户的RSA密钥（单服务商模式：不按 provider_id 过滤）
    const [records] = await db.query(
      `SELECT pid, rsa_public_key, rsa_private_key 
       FROM merchants 
       WHERE user_id = ? AND status IN ('active', 'approved')
       LIMIT 1`,
      [user_id]
    );

    if (records.length === 0) {
      return res.json({ code: -1, msg: '未找到记录或未审核通过' });
    }

    const record = records[0];
    if (!record.rsa_public_key || !record.rsa_private_key) {
      return res.json({ code: -1, msg: 'V2密钥尚未生成，请联系服务商' });
    }

    res.json({
      code: 0,
      data: {
        pid: record.pid,
        publicKey: record.rsa_public_key,
        privateKey: record.rsa_private_key
      }
    });
  } catch (error) {
    console.error('获取V2密钥错误:', error);
    res.json({ code: -1, msg: '获取密钥失败' });
  }
});

// 重置PID的V2接口密钥（重新生成RSA密钥对）- 单服务商模式
router.post('/provider/v2-keys/reset', async (req, res) => {
  try {
    const { user_id } = req.user;

    // 验证商户记录（单服务商模式：不按 provider_id 过滤）
    const [records] = await db.query(
      `SELECT id, pid FROM merchants 
       WHERE user_id = ? AND status IN ('active', 'approved')
       LIMIT 1`,
      [user_id]
    );

    if (records.length === 0) {
      return res.json({ code: -1, msg: '未找到记录或未审核通过' });
    }

    const record = records[0];

    // 生成新的RSA密钥对（helpers 已返回 Base64，兼容 PHP）
    const { publicKey: publicKeyBase64, privateKey: privateKeyBase64 } = generateRsaKeyPair();

    // 更新数据库
    await db.query(
      `UPDATE merchants 
       SET rsa_public_key = ?, rsa_private_key = ? 
       WHERE id = ?`,
      [publicKeyBase64, privateKeyBase64, record.id]
    );

    res.json({
      code: 0,
      msg: '密钥重置成功',
      data: {
        pid: record.pid,  // API 使用的12位随机ID
        publicKey: publicKeyBase64,
        privateKey: privateKeyBase64
      }
    });
  } catch (error) {
    console.error('重置V2密钥错误:', error);
    res.json({ code: -1, msg: '重置密钥失败' });
  }
});

// ==================== 域名白名单管理 ====================

// 获取商户的域名列表
router.get('/domains', async (req, res) => {
  try {
    const { user_id } = req.user;
    
    const [domains] = await db.query(
      `SELECT id, domain, status, review_note, created_at, reviewed_at 
       FROM merchant_domains 
       WHERE merchant_id = ? 
       ORDER BY created_at DESC`,
      [user_id]
    );
    
    res.json({ code: 0, data: domains });
  } catch (error) {
    console.error('获取域名列表失败:', error);
    res.json({ code: -1, msg: '获取域名列表失败' });
  }
});

// 提交新域名申请
router.post('/domains/add', requireMerchantMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    const { domain } = req.body;
    
    if (!domain || typeof domain !== 'string') {
      return res.json({ code: -1, msg: '请输入有效的域名' });
    }
    
    // 清理域名格式（移除协议、路径等，只保留主机名）
    let cleanDomain = domain.trim().toLowerCase();
    cleanDomain = cleanDomain.replace(/^https?:\/\//, '');  // 移除协议
    cleanDomain = cleanDomain.replace(/\/.*$/, '');  // 移除路径
    cleanDomain = cleanDomain.replace(/:\d+$/, '');  // 移除端口
    
    // 验证域名格式
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
    if (!domainRegex.test(cleanDomain)) {
      return res.json({ code: -1, msg: '域名格式无效' });
    }
    
    // 检查是否已存在该域名
    const [existing] = await db.query(
      'SELECT id, status FROM merchant_domains WHERE merchant_id = ? AND domain = ?',
      [user_id, cleanDomain]
    );
    
    if (existing.length > 0) {
      const status = existing[0].status;
      if (status === 'pending') {
        return res.json({ code: -1, msg: '该域名已在审核中' });
      } else if (status === 'approved') {
        return res.json({ code: -1, msg: '该域名已通过审核' });
      }
      // rejected 状态可以重新提交，删除旧记录
      await db.query('DELETE FROM merchant_domains WHERE id = ?', [existing[0].id]);
    }
    
    // 检查该域名是否被其他商户使用
    const [otherMerchant] = await db.query(
      'SELECT merchant_id FROM merchant_domains WHERE domain = ? AND merchant_id != ? AND status = ?',
      [cleanDomain, user_id, 'approved']
    );
    
    if (otherMerchant.length > 0) {
      return res.json({ code: -1, msg: '该域名已被其他商户绑定' });
    }
    
    // 插入新域名申请
    await db.query(
      'INSERT INTO merchant_domains (merchant_id, domain, status, created_at) VALUES (?, ?, ?, NOW())',
      [user_id, cleanDomain, 'pending']
    );
    
    res.json({ code: 0, msg: '域名提交成功，等待审核' });
  } catch (error) {
    console.error('提交域名失败:', error);
    res.json({ code: -1, msg: '提交域名失败' });
  }
});

// 删除域名（仅 pending 和 rejected 状态可删除）
router.post('/domains/delete', requireMerchantMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id } = req.body;
    
    if (!id) {
      return res.json({ code: -1, msg: '缺少域名ID' });
    }
    
    // 检查域名是否存在且属于当前商户
    const [domains] = await db.query(
      'SELECT id, status FROM merchant_domains WHERE id = ? AND merchant_id = ?',
      [id, user_id]
    );
    
    if (domains.length === 0) {
      return res.json({ code: -1, msg: '域名不存在' });
    }
    
    if (domains[0].status === 'approved') {
      return res.json({ code: -1, msg: '已审核通过的域名不能删除，请联系管理员' });
    }
    
    await db.query('DELETE FROM merchant_domains WHERE id = ?', [id]);
    
    res.json({ code: 0, msg: '域名已删除' });
  } catch (error) {
    console.error('删除域名失败:', error);
    res.json({ code: -1, msg: '删除域名失败' });
  }
});

module.exports = router;
