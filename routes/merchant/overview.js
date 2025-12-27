/**
 * 商户概览路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');

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

// 获取商户概览数据
router.get('/overview', async (req, res) => {
  try {
    const { user_id } = req.user;
    const merchant = req.merchant;
    
    // 获取今日数据
    const today = new Date().toISOString().split('T')[0];
    
    const [[todayStats]] = await db.query(
      `SELECT 
        COUNT(*) as order_count,
        COALESCE(SUM(CASE WHEN status = 1 THEN money ELSE 0 END), 0) as total_money,
        COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as success_count
       FROM orders 
       WHERE merchant_id = ? AND DATE(created_at) = ?`,
      [user_id, today]
    );

    // 获取总数据
    const [[totalStats]] = await db.query(
      `SELECT 
        COUNT(*) as order_count,
        COALESCE(SUM(CASE WHEN status = 1 THEN money ELSE 0 END), 0) as total_money,
        COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as success_count
       FROM orders 
       WHERE merchant_id = ?`,
      [user_id]
    );

    // 获取已加入的服务商数量（单服务商模式，只有一条记录）
    const [[providerCount]] = await db.query(
      'SELECT COUNT(*) as count FROM merchants WHERE user_id = ? AND status IN ("active", "approved")',
      [user_id]
    );

    // 获取商户的支付组费率信息
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
        'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
      );
      if (defaultGroups.length > 0) payGroup = defaultGroups[0];
    }

    // 解析支付组配置，获取每个支付类型的费率
    const allPayTypes = getAllPayTypes();
    let rates = [];

    // 解析商户独立费率
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

    if (payGroup && payGroup.config) {
      try {
        const config = typeof payGroup.config === 'string' 
          ? JSON.parse(payGroup.config) 
          : payGroup.config;
        
        for (const [payTypeId, typeConfig] of Object.entries(config)) {
          const pt = allPayTypes.find(p => p.id === parseInt(payTypeId));
          if (pt && typeConfig.rate !== undefined && typeConfig.rate !== null) {
            // 费率优先级：商户通道独立费率 > 商户统一费率 > 支付组费率
            let finalRate;
            if (merchantFeeRates && merchantFeeRates[pt.name] !== undefined) {
              finalRate = merchantFeeRates[pt.name];
            } else if (merchant.fee_rate !== null && merchant.fee_rate !== undefined) {
              finalRate = merchant.fee_rate;
            } else {
              finalRate = typeConfig.rate / 100;
            }
            rates.push({
              pay_type: pt.name,
              pay_type_name: pt.showname,
              rate: finalRate
            });
          }
        }
      } catch (e) {
        console.error('解析支付组配置错误:', e);
      }
    }

    res.json({
      code: 0,
      data: {
        today: todayStats,
        total: totalStats,
        providerCount: providerCount.count,
        merchant: {
          api_key: merchant.api_key,
          notify_url: merchant.notify_url,
          return_url: merchant.return_url,
          status: merchant.status
        },
        pay_group_name: payGroup?.name || null,
        rates // 每个支付类型的费率
      }
    });
  } catch (error) {
    console.error('获取概览数据错误:', error);
    res.json({ code: -1, msg: '获取数据失败' });
  }
});

module.exports = router;
