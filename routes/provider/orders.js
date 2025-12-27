/**
 * Provider 订单管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const payment = require('../../utils/payment');
const { requireProviderRamPermission } = require('../auth');

// 获取交易流水（需要 order 权限）
router.get('/orders', requireProviderRamPermission('order'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, startDate, endDate, merchantId, tradeNo } = req.query;
    
    // 单服务商模式，不按 provider_id 过滤
    let sql = `SELECT o.id, o.trade_no, o.out_trade_no, o.merchant_id, o.pay_type, o.name,
               o.money, o.fee_money as fee, o.notify_url, o.return_url,
               o.status, o.created_at, o.paid_at, 
               o.notify_status, o.notify_count, o.notify_time, o.merchant_confirm,
               o.refund_status, o.refund_money, o.refund_no, o.refund_at,
               u.username as merchant_name,
               pc.channel_name as channel_name, pc.plugin_name as channel_plugin
               FROM orders o 
               LEFT JOIN users u ON o.merchant_id = u.id 
               LEFT JOIN provider_channels pc ON o.channel_id = pc.id
               WHERE 1=1`;
    const params = [];

    // 构建筛选条件
    let whereConditions = '';
    
    if (status !== undefined && status !== '') {
      whereConditions += ' AND o.status = ?';
      params.push(status);
    }

    if (startDate) {
      whereConditions += ' AND DATE(o.created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      whereConditions += ' AND DATE(o.created_at) <= ?';
      params.push(endDate);
    }

    if (merchantId) {
      whereConditions += ' AND o.merchant_id = ?';
      params.push(merchantId);
    }

    if (tradeNo) {
      whereConditions += ' AND (o.trade_no LIKE ? OR o.out_trade_no LIKE ?)';
      params.push(`%${tradeNo}%`, `%${tradeNo}%`);
    }

    sql += whereConditions;

    // 获取总数
    const countSql = `SELECT COUNT(*) as total FROM orders o WHERE 1=1` + whereConditions;
    const [countResult] = await db.query(countSql, params);
    const total = countResult[0].total;

    // 获取统计数据（成功订单的金额和手续费）
    const statsSql = `SELECT COALESCE(SUM(o.money), 0) as totalMoney, COALESCE(SUM(o.fee_money), 0) as totalFee 
                      FROM orders o WHERE o.status = 1` + whereConditions;
    const [statsResult] = await db.query(statsSql, params);
    const totalMoney = statsResult[0].totalMoney || 0;
    const totalFee = statsResult[0].totalFee || 0;

    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    const queryParams = [...params, parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)];

    const [orders] = await db.query(sql, queryParams);

    res.json({
      code: 0,
      data: {
        list: orders,
        total,
        totalMoney,
        totalFee,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取订单错误:', error);
    res.json({ code: -1, msg: '获取订单失败' });
  }
});

// 强制完成订单（需要 order 权限）
router.post('/orders/force-complete', requireProviderRamPermission('order'), async (req, res) => {
  try {
    const { trade_no } = req.body;

    if (!trade_no) {
      return res.json({ code: -1, msg: '订单号不能为空' });
    }

    // 查询订单（单服务商模式，不按 provider_id 过滤）
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态
    if (order.status === 1) {
      return res.json({ code: -1, msg: '订单已完成' });
    }

    if (order.status === 2 && order.merchant_confirm !== 1) {
      return res.json({ code: -1, msg: '订单已关闭' });
    }

    // 使用事务保护，避免重复增加余额
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      
      // 检查是否已增加过余额（使用 FOR UPDATE 锁定行）
      const [orderCheck] = await connection.query(
        'SELECT balance_added FROM orders WHERE id = ? FOR UPDATE', 
        [order.id]
      );
      
      // 更新订单状态为已支付
      await connection.query(
        'UPDATE orders SET status = 1, paid_at = NOW() WHERE id = ?',
        [order.id]
      );
      
      // 增加商户余额（订单金额 - 手续费）- 仅在未增加过时执行
      if (orderCheck.length > 0 && !orderCheck[0].balance_added) {
        const settleAmount = parseFloat(order.money) - parseFloat(order.fee_money || 0);
        await connection.query(
          'UPDATE merchants SET balance = balance + ? WHERE user_id = ?',
          [settleAmount, order.merchant_id]
        );
        // 标记已增加余额
        await connection.query('UPDATE orders SET balance_added = 1 WHERE id = ?', [order.id]);
        console.log(`强制完成订单 - 商户余额增加: user_id=${order.merchant_id}, amount=${settleAmount}`);
      }
      
      await connection.commit();
    } catch (txError) {
      await connection.rollback();
      throw txError;
    } finally {
      connection.release();
    }

    // 获取商户密钥用于签名
    const [merchants] = await db.query(
      'SELECT api_key, pid FROM merchants WHERE user_id = ?',
      [order.merchant_id]
    );
    
    if (merchants.length > 0) {
      const merchant = merchants[0];
      
      // 构建回调参数（带签名）
      const notifyParams = payment.buildCallbackParams(order, merchant.api_key, merchant.pid);
      
      // 发送回调并更新状态
      if (order.notify_url) {
        const success = await payment.sendNotify(order.notify_url, notifyParams);
        await db.query(
          'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
          [success ? 1 : 2, order.id]
        );
      }
    }

    res.json({ code: 0, msg: order.merchant_confirm === 1 ? '订单已确认支付' : '订单已强制完成' });
  } catch (error) {
    console.error('强制完成订单错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

// 重发回调（已支付订单）（需要 order 权限）
// 服务商点击回调 = 确认支付成功，如果商户之前认账了，则标记为正常入账
router.post('/orders/notify', requireProviderRamPermission('order'), async (req, res) => {
  try {
    const { trade_no } = req.body;

    if (!trade_no) {
      return res.json({ code: -1, msg: '订单号不能为空' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态
    if (order.status !== 1) {
      return res.json({ code: -1, msg: '只有已支付订单可以重发回调' });
    }

    if (!order.notify_url) {
      return res.json({ code: -1, msg: '订单未设置回调地址' });
    }

    // 如果商户之前认账了（merchant_confirm=1），服务商点击回调后清除认账标记，变成正常入账
    if (order.merchant_confirm === 1) {
      await db.query(
        'UPDATE orders SET merchant_confirm = 0 WHERE id = ?',
        [order.id]
      );
    }

    // 获取商户密钥用于签名
    const [merchants] = await db.query(
      'SELECT api_key, pid FROM merchants WHERE user_id = ?',
      [order.merchant_id]
    );
    
    if (merchants.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    const merchant = merchants[0];
    
    // 构建回调参数（带签名）
    const notifyParams = payment.buildCallbackParams(order, merchant.api_key, merchant.pid);
    
    // 发送回调并更新状态
    const success = await payment.sendNotify(order.notify_url, notifyParams);
    await db.query(
      'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
      [success ? 1 : 2, order.id]
    );

    if (success) {
      res.json({ code: 0, msg: '回调成功' });
    } else {
      res.json({ code: -1, msg: '回调失败：商户服务器未返回 success' });
    }
  } catch (error) {
    console.error('重发回调错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

// 退款订单（需要 order 权限）
router.post('/orders/refund', requireProviderRamPermission('order'), async (req, res) => {
  try {
    const { trade_no, money } = req.body;

    if (!trade_no) {
      return res.json({ code: 1, msg: '缺少订单号' });
    }

    // 查询订单（单服务商模式）
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态：已支付(1)、已退款但有剩余(2)、已冻结(3) 可以退款
    if (![1, 2, 3].includes(order.status)) {
      return res.json({ code: 1, msg: '订单状态不允许退款' });
    }

    // 已退款订单检查剩余可退金额
    const refundedMoney = parseFloat(order.refund_money || 0);
    const realMoney = parseFloat(order.real_money || order.money);
    
    if (order.status === 2 && refundedMoney >= realMoney) {
      return res.json({ code: 1, msg: '订单已全额退款' });
    }

    // 计算退款金额
    const maxRefund = order.status === 2 ? (realMoney - refundedMoney) : realMoney;
    const refundMoney = money ? Math.min(parseFloat(money), maxRefund) : maxRefund;
    
    if (refundMoney <= 0) {
      return res.json({ code: 1, msg: '退款金额无效' });
    }

    // 生成退款单号
    const refundNo = 'R' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase();

    // 计算需要扣减的商户余额（管理员退款不检查余额，可以为负）
    // 逻辑：退款扣除商户实收金额，即订单金额减去手续费
    // 例如：订单10元，手续费1元，商户实收9元，退款时扣9元
    let reduceMoney;
    const orderMoney = parseFloat(order.money);
    const feeMoney = parseFloat(order.fee_money || 0);
    const merchantReceived = orderMoney - feeMoney;  // 商户实收金额
    
    if (order.status === 3) {
      // 已冻结订单不扣余额
      reduceMoney = 0;
    } else if (refundMoney >= orderMoney) {
      // 全额退款：扣除商户实收金额
      reduceMoney = merchantReceived;
    } else {
      // 部分退款：按比例扣除（退款金额/订单金额 * 实收金额）
      reduceMoney = (refundMoney / orderMoney) * merchantReceived;
    }
    
    reduceMoney = Math.round(reduceMoney * 100) / 100;  // 保留2位小数

    // 如果有上游交易号，尝试调用插件退款
    let pluginRefundSuccess = false;
    if (order.api_trade_no && order.channel_id) {
      const [channels] = await db.query('SELECT * FROM provider_channels WHERE id = ?', [order.channel_id]);
      if (channels.length > 0) {
        const channel = channels[0];
        const pluginLoader = require('../../plugins');
        const plugin = pluginLoader.getPlugin(channel.plugin_name);
        
        if (plugin && typeof plugin.refund === 'function') {
          try {
            let channelConfig;
            try {
              channelConfig = channel.config ? JSON.parse(channel.config) : {};
            } catch (e) {
              channelConfig = {};
            }
            
            const fullConfig = {
              ...channelConfig,
              appid: channel.app_id,
              appmchid: channel.app_mch_id,
              appkey: channel.app_key,
              appsecret: channel.app_secret
            };

            const refundResult = await plugin.refund(fullConfig, {
              trade_no: order.trade_no,
              api_trade_no: order.api_trade_no,
              refund_no: refundNo,
              refund_money: refundMoney,
              total_money: realMoney
            });

            if (refundResult.code === 0) {
              pluginRefundSuccess = true;
            } else {
              console.warn('插件退款失败:', refundResult.msg);
            }
          } catch (pluginError) {
            console.warn('调用退款插件异常:', pluginError.message);
          }
        }
      }
    }

    // 使用事务处理余额扣减和订单状态更新
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // 扣减商户余额（管理员退款不检查余额，可以为负）
      if (reduceMoney > 0) {
        await connection.query(
          'UPDATE merchants SET balance = balance - ? WHERE user_id = ?',
          [reduceMoney, order.merchant_id]
        );
      }

      // 更新订单状态
      const newRefundMoney = refundedMoney + refundMoney;
      await connection.query(
        `UPDATE orders SET status = 2, refund_status = 1, refund_no = ?, refund_money = ?, refund_at = NOW() WHERE id = ?`,
        [refundNo, newRefundMoney, order.id]
      );

      await connection.commit();
    } catch (txError) {
      await connection.rollback();
      throw txError;
    } finally {
      connection.release();
    }

    // 获取商户密钥
    const [merchants] = await db.query(
      'SELECT api_key, pid FROM merchants WHERE user_id = ?',
      [order.merchant_id]
    );

    // 发送退款回调通知（如果有回调地址）
    if (order.notify_url && merchants.length > 0) {
      const merchant = merchants[0];
      const notifyParams = payment.buildCallbackParams({
        pid: merchant.pid,
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        type: order.pay_type || 'unknown',
        name: order.name || '',
        money: parseFloat(order.money).toFixed(2),
        trade_status: 'REFUND',
        refund_no: refundNo
      }, merchant.api_key);

      // 异步发送回调
      payment.sendNotify(order.notify_url, notifyParams).catch(err => {
        console.error('发送退款回调失败:', err);
      });
    }

    res.json({ 
      code: 0, 
      msg: pluginRefundSuccess ? '退款成功（已原路退回）' : '退款成功（仅更新状态）',
      data: { refundNo, refundMoney: refundMoney.toFixed(2), reduceMoney: reduceMoney.toFixed(2) }
    });
  } catch (error) {
    console.error('退款订单错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

module.exports = router;
