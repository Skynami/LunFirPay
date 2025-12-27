/**
 * Provider 概览统计路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// 获取管理后台概览数据
router.get('/overview', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // 今日数据（单服务商模式，不按 provider_id 过滤）
    const [[todayStats]] = await db.query(
      `SELECT 
        COUNT(*) as order_count,
        COALESCE(SUM(CASE WHEN status = 1 THEN money ELSE 0 END), 0) as total_money,
        COALESCE(SUM(CASE WHEN status = 1 THEN fee_money ELSE 0 END), 0) as fee_money,
        COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as success_count
       FROM orders 
       WHERE DATE(created_at) = ?`,
      [today]
    );

    // 总数据（包含通道成本计算）
    const [[totalStats]] = await db.query(
      `SELECT 
        COUNT(*) as order_count,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN o.money ELSE 0 END), 0) as total_money,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN o.fee_money ELSE 0 END), 0) as fee_money,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN o.money * COALESCE(pc.cost_rate, 0) ELSE 0 END), 0) as cost_money,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN 1 ELSE 0 END), 0) as success_count
       FROM orders o
       LEFT JOIN provider_channels pc ON o.channel_id = pc.id`
    );

    // 商户数量
    const [[merchantCount]] = await db.query(
      'SELECT COUNT(*) as count FROM merchants WHERE status IN ("active", "approved")'
    );

    // 通道流水TOP5
    const [topChannels] = await db.query(
      `SELECT 
        pc.id as channel_id,
        pc.channel_name,
        pc.pay_type,
        COUNT(o.id) as order_count,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN o.money ELSE 0 END), 0) as total_money,
        COALESCE(SUM(CASE WHEN o.status = 1 THEN 1 ELSE 0 END), 0) as success_count
       FROM provider_channels pc
       LEFT JOIN orders o ON o.channel_id = pc.id
       WHERE pc.status = 1
       GROUP BY pc.id, pc.channel_name, pc.pay_type
       ORDER BY total_money DESC
       LIMIT 5`
    );

    // 计算成功率
    const topChannelsWithRate = topChannels.map(ch => ({
      ...ch,
      success_rate: ch.order_count > 0 ? ch.success_count / ch.order_count : 0
    }));

    res.json({
      code: 0,
      data: {
        today: todayStats,
        total: totalStats,
        merchantCount: merchantCount.count,
        topChannels: topChannelsWithRate
      }
    });
  } catch (error) {
    console.error('获取概览数据错误:', error);
    res.json({ code: -1, msg: '获取数据失败' });
  }
});

module.exports = router;
